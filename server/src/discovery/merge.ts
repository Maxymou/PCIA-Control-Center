/** Fusion détection ↔ configuration utilisateur.
 *
 *  Ordre de priorité, du plus fort au plus faible :
 *    1. correction manuelle (jamais écrasée par une détection ultérieure) ;
 *    2. détection courante ;
 *    3. dernière détection connue (pour marquer « perdue » plutôt que disparue).
 *
 *  Quand une nouvelle détection contredit une correction, la correction est
 *  conservée **et** un conflit est enregistré : c'est l'utilisateur qui tranche.
 */

import type { Connection, ConnectionConflict, Service } from '../contract.js';
import type { ConnectionsRepo, ServicesRepo } from '../db/repositories.js';
import { connectionShapeChanged } from './connections.js';
import {
  DEFAULT_VISIBLE_CATEGORIES, type DetectedConnection, type DetectedService,
} from './model.js';

/** Durée pendant laquelle une connexion disparue reste affichée comme « perdue ». */
const LOST_RETENTION_MS = 15 * 60_000;
/** Durée pendant laquelle une connexion fraîchement détectée est marquée « nouvelle ». */
const NEW_WINDOW_MS = 2 * 60_000;
/** Idem pour les services. */
const SERVICE_NEW_WINDOW_MS = 5 * 60_000;

interface TrackedConnection {
  connection: DetectedConnection;
  firstSeen: number;
  lastSeen: number;
}

interface TrackedService {
  firstSeen: number;
  lastSeen: number;
  lastStatus: Service['status'];
}

export interface MergeOptions {
  /** Inclure les services classés « système » et les éléments masqués. */
  includeHidden?: boolean;
  /** Inclure les connexions de faible confiance masquées par défaut. */
  includeLowConfidence?: boolean;
}

export interface MergeResult {
  services: Service[];
  connections: Connection[];
  conflicts: ConnectionConflict[];
  /** Nouveaux conflits créés lors de ce cycle (à journaliser une seule fois). */
  newConflicts: string[];
  /** Changements d'état à journaliser. */
  serviceTransitions: { service: Service; from: Service['status']; to: Service['status'] }[];
  appearedServices: Service[];
  lostConnections: Connection[];
}

/** Conserve la mémoire des cycles précédents (états perdus, nouveautés). */
export class DiscoveryTracker {
  private connections = new Map<string, TrackedConnection>();
  private services = new Map<string, TrackedService>();
  /** Le premier cycle établit la référence : rien n'y est « nouveau ». */
  private primed = false;

  merge(
    detectedServices: DetectedService[],
    detectedConnections: DetectedConnection[],
    repos: { services: ServicesRepo; connections: ConnectionsRepo },
    opts: MergeOptions = {},
  ): MergeResult {
    const now = Date.now();
    const serviceTransitions: MergeResult['serviceTransitions'] = [];
    const appearedServices: Service[] = [];

    // ---------- Services ----------
    const overrides = new Map(repos.services.listOverrides().map((o) => [o.serviceId, o]));
    const outServices: Service[] = [];

    for (const detected of detectedServices) {
      const override = overrides.get(detected.id);
      const hidden = override?.hidden ?? false;
      const hiddenByCategory = detected.hiddenByDefault
        && !DEFAULT_VISIBLE_CATEGORIES.includes(detected.category);
      if ((hidden || hiddenByCategory) && !opts.includeHidden) {
        this.services.set(detected.id, {
          firstSeen: this.services.get(detected.id)?.firstSeen ?? now,
          lastSeen: now,
          lastStatus: detected.status,
        });
        continue;
      }

      const tracked = this.services.get(detected.id);
      if (tracked && tracked.lastStatus !== detected.status) {
        serviceTransitions.push({ service: detected, from: tracked.lastStatus, to: detected.status });
      }
      const firstSeen = tracked?.firstSeen ?? now;
      if (!tracked && this.primed) appearedServices.push(detected);
      this.services.set(detected.id, { firstSeen, lastSeen: now, lastStatus: detected.status });

      const merged: Service = {
        ...detected,
        ...(override?.patch ?? {}),
        // L'origine reste « détectée » même corrigée : le front distingue les
        // services manuels des services détectés puis annotés.
        origin: 'detected',
        note: override?.note ?? override?.patch?.note ?? detected.note,
        // « Nouveau » = apparu après la mise en place de la référence, sinon
        // tout le parc serait signalé comme nouveau au démarrage.
        isNew: this.primed && now - firstSeen < SERVICE_NEW_WINDOW_MS,
      };
      outServices.push(merged);
    }

    // Services manuels : toujours présents, jamais écrasés.
    for (const manual of repos.services.listManual()) {
      const override = overrides.get(manual.id);
      if (override?.hidden && !opts.includeHidden) continue;
      outServices.push({ ...manual, ...(override?.patch ?? {}), origin: 'manual' });
    }

    const knownServiceIds = new Set(outServices.map((s) => s.id));

    // ---------- Connexions ----------
    const connOverrides = new Map(repos.connections.listOverrides().map((o) => [o.connectionId, o]));
    const newConflicts: string[] = [];
    const detectedIds = new Set<string>();

    for (const detected of detectedConnections) {
      detectedIds.add(detected.id);
      const prev = this.connections.get(detected.id);
      this.connections.set(detected.id, {
        connection: detected,
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
      });

      const override = connOverrides.get(detected.id);
      if (!override) continue;

      // Une correction existe : vérifier si la nouvelle détection la contredit.
      const corrected = { ...detected, ...override.patch };
      const contradicts = connectionShapeChanged(
        {
          sourceId: corrected.sourceId, targetId: corrected.targetId, type: corrected.type,
          port: corrected.port, endpoint: corrected.endpoint,
        },
        {
          sourceId: detected.sourceId, targetId: detected.targetId, type: detected.type,
          port: detected.port, endpoint: detected.endpoint,
        },
      );
      if (contradicts && Object.keys(override.patch).length > 0 && !repos.connections.hasOpenConflict(detected.id)) {
        repos.connections.recordConflict(detected.id, {
          sourceId: detected.sourceId,
          targetId: detected.targetId,
          type: detected.type,
          port: detected.port,
          endpoint: detected.endpoint,
        });
        newConflicts.push(detected.id);
      }
    }

    // Connexions disparues : « perdues » plutôt que silencieusement retirées.
    const lostConnections: Connection[] = [];
    for (const [id, tracked] of [...this.connections]) {
      if (detectedIds.has(id)) continue;
      if (now - tracked.lastSeen > LOST_RETENTION_MS) {
        this.connections.delete(id);
        continue;
      }
      if (tracked.connection.status !== 'lost') {
        tracked.connection = { ...tracked.connection, status: 'lost' };
        lostConnections.push(tracked.connection);
      }
    }

    const outConnections: Connection[] = [];
    for (const [id, tracked] of this.connections) {
      const detected = tracked.connection;
      const override = connOverrides.get(id);
      if (override?.hidden && !opts.includeHidden) continue;
      if (detected.hiddenByDefault && !opts.includeLowConfidence && !opts.includeHidden) continue;

      const isNew = this.primed && now - tracked.firstSeen < NEW_WINDOW_MS;
      const base: Connection = {
        ...detected,
        status: detected.status === 'lost'
          ? 'lost'
          : isNew ? 'new' : detected.status,
      };

      if (override && Object.keys(override.patch).length > 0) {
        // La correction est prioritaire et conserve la détection d'origine.
        outConnections.push({
          ...base,
          ...override.patch,
          origin: 'corrected',
          note: override.note ?? override.patch.note ?? base.note,
          detectedOriginal: override.detectedOriginal ?? {
            sourceId: detected.sourceId,
            targetId: detected.targetId,
            type: detected.type,
            port: detected.port,
            endpoint: detected.endpoint,
          },
        });
      } else {
        outConnections.push({ ...base, note: override?.note ?? base.note });
      }
    }

    for (const manual of repos.connections.listManual()) {
      const override = connOverrides.get(manual.id);
      if (override?.hidden && !opts.includeHidden) continue;
      outConnections.push({ ...manual, ...(override?.patch ?? {}), origin: 'manual' });
    }

    // Une connexion dont une extrémité n'existe plus ne peut pas être affichée
    // dans le graphe : on la garde en base mais on ne la renvoie pas.
    const renderable = outConnections.filter(
      (c) => knownServiceIds.has(c.sourceId) && knownServiceIds.has(c.targetId),
    );

    // À partir du deuxième cycle, les apparitions sont de vraies nouveautés.
    this.primed = true;

    return {
      services: outServices,
      connections: renderable,
      conflicts: repos.connections.listConflicts(),
      newConflicts,
      serviceTransitions,
      appearedServices,
      lostConnections,
    };
  }

  /** Détection courante d'une connexion — utilisée pour restaurer la version détectée. */
  detectedById(id: string): DetectedConnection | null {
    return this.connections.get(id)?.connection ?? null;
  }

  reset(): void {
    this.connections.clear();
    this.services.clear();
    this.primed = false;
  }
}
