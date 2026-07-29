/** Orchestrateur applicatif.
 *
 *  Rassemble matériel, services, connexions, ventilation, alertes et historique
 *  en un `ServerSnapshot` — surensemble strict du `Snapshot` attendu par le
 *  front-end existant, pour ne rien casser des composants en place.
 *
 *  Chaque source a sa propre cadence : on ne relance pas `nvidia-smi` ni
 *  `docker inspect` toutes les secondes.
 */

import type { AppConfig } from '../config.js';
import { fanStatePath } from '../config.js';
import type {
  CalibrationRecord, FanEngineState, FanLive, HardwareId, HistoryPoint,
  ServerSnapshot, Severity, SystemStatus,
} from '../contract.js';
import { FAN_IDS } from '../contract.js';
import type { Repositories } from '../db/repositories.js';
import { discoverConnections } from '../discovery/connections.js';
import { DiscoveryTracker } from '../discovery/merge.js';
import type { DetectedConnection, DetectedService } from '../discovery/model.js';
import { readSockets } from '../discovery/ports.js';
import { discoverServices } from '../discovery/services.js';
import { HardwareInventory } from '../hardware/inventory.js';
import { createLogger } from '../logger.js';
import { readSystemInfo } from '../system/info.js';
import { readStateFile } from '../fan/ipc.js';
import type { FanHost } from '../fan/host.js';
import { AlertEvaluator } from './alerts.js';
import type { RuntimeEnv } from '../runtime.js';

const log = createLogger('app.state');

export const APP_VERSION = '1.0.0';

/** Fenêtre servie au front-end. */
export const HISTORY_WINDOW_MS = 60 * 60 * 1000;

export interface AppStateOptions {
  env: RuntimeEnv;
  repos: Repositories;
  /** Moteur embarqué, si l'API l'héberge. */
  embeddedFanHost: FanHost | null;
  /** Lecture de l'état du moteur externe (fichier ou IPC). */
  externalFanState?: () => FanEngineState | null;
  onSnapshot?: (snapshot: ServerSnapshot) => void;
  onEvent?: (kind: string, payload: unknown) => void;
}

export class AppState {
  private inventory: HardwareInventory;
  private tracker = new DiscoveryTracker();
  private alertEvaluator: AlertEvaluator;
  private config: AppConfig;

  private detectedServices: DetectedService[] = [];
  private detectedConnections: DetectedConnection[] = [];
  private lastSnapshot: ServerSnapshot | null = null;
  private startedAt = Date.now();

  private timers: ReturnType<typeof setInterval>[] = [];
  private lastHistoryAt = 0;
  private discovering = false;

  constructor(private opts: AppStateOptions) {
    this.config = opts.env.config;
    this.inventory = new HardwareInventory({
      hwmon: opts.env.hwmon,
      settings: opts.repos.settings,
      config: this.config,
      gpuProvider: opts.env.demo ? () => opts.env.demo!.gpus() : undefined,
      storageProvider: opts.env.demo ? () => opts.env.demo!.storage() : undefined,
    });
    this.alertEvaluator = new AlertEvaluator(this.config, opts.repos.alerts, opts.repos.events);
  }

  // =====================================================================
  // Cycle de vie
  // =====================================================================

  async start(): Promise<void> {
    await this.inventory.refreshStatic();
    this.inventory.sampleFast();
    await this.runDiscovery();
    this.rebuild();

    const c = this.config.collector;
    this.timers.push(setInterval(() => this.safe('sensors', () => {
      this.opts.env.demo?.step();
      this.inventory.sampleFast();
      this.rebuild();
    }), c.sensorsIntervalMs));

    this.timers.push(setInterval(() => this.safe('gpu', async () => {
      await this.inventory.sampleGpus();
    }), c.powerIntervalMs));

    this.timers.push(setInterval(() => this.safe('storage', async () => {
      await this.inventory.sampleStorage();
    }), c.storageIntervalMs));

    this.timers.push(setInterval(() => this.safe('discovery', async () => {
      await this.runDiscovery();
      this.rebuild();
    }), Math.min(c.servicesIntervalMs, c.connectionsIntervalMs)));

    this.timers.push(setInterval(() => this.safe('inventory', async () => {
      await this.inventory.refreshStatic();
    }), c.inventoryIntervalMs));

    this.timers.push(setInterval(() => this.safe('purge', () => this.purge()), this.config.history.purgeIntervalMs));

    this.opts.repos.events.append({
      category: 'config', level: 'normal', targetLabel: 'PCIA Control Center',
      message: `Back-end démarré (mode ${this.opts.env.mode}, port ${this.config.server.port}).`,
    });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private safe(label: string, fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch((err) => log.error('Tâche périodique en échec', { label, error: err }));
      }
    } catch (err) {
      log.error('Tâche périodique en échec', { label, error: err });
    }
  }

  // =====================================================================
  // Détection
  // =====================================================================

  private async runDiscovery(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      if (this.opts.env.demo) {
        this.detectedServices = this.opts.env.demo.services();
        this.detectedConnections = this.opts.env.demo.connections();
        const conflict = this.opts.env.demo.conflictTarget();
        if (conflict && !this.opts.repos.connections.hasOpenConflict(conflict.connectionId)) {
          // Le scénario de démonstration a besoin d'une correction préexistante.
          if (!this.opts.repos.connections.getOverride(conflict.connectionId)) {
            const base = this.detectedConnections.find((c) => c.id === conflict.connectionId);
            if (base) {
              this.opts.repos.connections.setCorrection(
                conflict.connectionId,
                { sourceId: base.sourceId, targetId: base.targetId, note: 'Sens corrigé manuellement (démonstration).' },
                { sourceId: base.sourceId, targetId: base.targetId, type: base.type, port: base.port, endpoint: base.endpoint },
              );
            }
          }
          this.opts.repos.connections.recordConflict(conflict.connectionId, conflict.detected);
        }
        return;
      }

      const sockets = await readSockets();
      const services = await discoverServices({ sockets, appVersion: APP_VERSION });
      this.detectedServices = services.services;
      const connections = await discoverConnections({
        services: services.services,
        portOwners: services.portOwners,
        pidOwners: services.pidOwners,
        sockets,
      });
      this.detectedConnections = connections.connections;
      for (const w of [...services.warnings, ...connections.warnings]) {
        log.throttled(w, 900_000, 'info', w);
      }
    } finally {
      this.discovering = false;
    }
  }

  // =====================================================================
  // Assemblage du snapshot
  // =====================================================================

  /** État du moteur de ventilation, embarqué ou externe. */
  private fanEngineState(): { state: FanEngineState | null; online: boolean; embedded: boolean } {
    if (this.opts.embeddedFanHost) {
      const state = this.opts.embeddedFanHost.state();
      return { state, online: true, embedded: true };
    }
    const state = this.opts.externalFanState
      ? this.opts.externalFanState()
      : readStateFile(fanStatePath(this.config));
    if (!state) return { state: null, online: false, embedded: false };
    const fresh = Date.now() - state.heartbeat <= this.config.fanControl.heartbeatTimeoutMs;
    return { state, online: fresh, embedded: false };
  }

  private buildFanLive(engineState: FanEngineState | null): FanLive[] {
    const configs = new Map(this.opts.repos.fanConfigs.list().map((c) => [c.id, c]));
    return FAN_IDS.map((id): FanLive => {
      const output = engineState?.outputs.find((o) => o.id === id);
      const cfg = configs.get(id);
      if (!output) {
        // Moteur injoignable : on ne fabrique pas de mesure.
        return { id, pwm: 0, rpm: 0, refTemp: 0, status: 'unknown' };
      }
      return {
        id,
        pwm: output.pwm,
        rpm: output.rpm ?? 0,
        refTemp: output.refTemp ?? 0,
        status: output.severity as Severity,
        testRemaining: output.testRemainingS ?? undefined,
        stalled: output.stalled,
      };
    }).map((live) => (configs.has(live.id) ? live : live));
  }

  private systemStatus(engine: { state: FanEngineState | null; online: boolean; embedded: boolean }): SystemStatus {
    const info = readSystemInfo();
    return {
      version: APP_VERSION,
      mode: this.opts.env.mode,
      degraded: this.opts.env.degraded,
      degradedReasons: this.opts.env.degradedReasons,
      startedAt: this.startedAt,
      kernel: info.kernel,
      distribution: info.distribution,
      hostname: info.hostname,
      fanEngine: {
        online: engine.online,
        lastHeartbeat: engine.state?.heartbeat ?? null,
        embedded: engine.embedded,
        failsafe: engine.state?.failsafe ?? false,
      },
      capabilities: this.inventory.capabilities({
        canReturnToBios: this.opts.repos.calibration.list().some((r) => r.biosReturn === 'CONFIRMED'),
        canControlFans: engine.online
          && (engine.state?.outputs.some((o) => o.controlState === 'SOFTWARE_CONTROLLED') ?? false),
      }),
    };
  }

  /** Recalcule le snapshot et le publie. */
  rebuild(): ServerSnapshot {
    const now = Date.now();
    const inventoryState = this.inventory.build();
    const engine = this.fanEngineState();

    const merged = this.tracker.merge(
      this.detectedServices,
      this.detectedConnections,
      { services: this.opts.repos.services, connections: this.opts.repos.connections },
    );

    // Journalisation des transitions notables (jamais chaque mesure).
    for (const t of merged.serviceTransitions) {
      this.opts.repos.events.append({
        category: 'service',
        level: t.to === 'crashed' || t.to === 'unreachable' ? 'critical' : 'normal',
        targetLabel: t.service.displayName ?? t.service.name,
        message: `État du service : ${t.from} → ${t.to}`,
      });
    }
    for (const s of merged.appearedServices) {
      this.opts.repos.events.append({
        category: 'service', level: 'normal',
        targetLabel: s.displayName ?? s.name, message: 'Nouveau service détecté',
      });
    }
    for (const c of merged.lostConnections) {
      this.opts.repos.events.append({
        category: 'connection', level: 'warning',
        targetLabel: `${c.sourceId} → ${c.targetId}`, message: 'Connexion perdue',
      });
    }
    for (const id of merged.newConflicts) {
      this.opts.repos.events.append({
        category: 'connection', level: 'warning', targetLabel: id,
        message: 'Nouvelle détection en contradiction avec une correction manuelle',
      });
    }
    for (const id of inventoryState.changes.appeared) {
      this.opts.repos.events.append({
        category: 'hardware', level: 'normal', targetLabel: id, message: 'Nouveau matériel détecté',
      });
    }
    for (const id of inventoryState.changes.disappeared) {
      this.opts.repos.events.append({
        category: 'hardware', level: 'warning', targetLabel: id, message: 'Matériel disparu',
      });
    }

    // Alertes.
    const primary = this.inventory.storageSummary()?.primary ?? null;
    this.alertEvaluator.evaluate({
      hardware: inventoryState.items,
      services: merged.services,
      connections: merged.connections,
      fanEngine: { online: engine.online, lastHeartbeat: engine.state?.heartbeat ?? null, state: engine.state },
      storageHealth: primary && primary.smartOk !== null
        ? {
          healthy: primary.smartOk && (primary.healthPercent ?? 100) > 10,
          detail: primary.healthPercent !== null ? `Santé ${primary.healthPercent} %` : undefined,
        }
        : null,
      conflicts: merged.conflicts,
    });

    // Historique.
    this.appendHistory(now, inventoryState.temps, engine.state);

    const from = now - HISTORY_WINDOW_MS;
    const snapshot: ServerSnapshot = {
      time: now,
      backendConnected: this.opts.env.demo ? this.opts.env.demo.backendConnected() : true,
      services: merged.services,
      connections: merged.connections,
      conflicts: merged.conflicts,
      hardware: inventoryState.items,
      fans: this.buildFanLive(engine.state),
      alerts: this.opts.repos.alerts.listRecent(120),
      events: this.opts.repos.events.list(200),
      history: this.opts.repos.history.range(from, now),
      markers: this.opts.repos.history.markers(from, now),
      system: this.systemStatus(engine),
      fanOutputs: engine.state?.outputs ?? [],
      calibration: this.opts.repos.calibration.list(),
    };

    this.lastSnapshot = snapshot;
    this.opts.onSnapshot?.(snapshot);
    return snapshot;
  }

  private appendHistory(now: number, temps: Partial<Record<HardwareId, number>>, engine: FanEngineState | null): void {
    if (now - this.lastHistoryAt < this.config.history.sampleIntervalMs) return;
    this.lastHistoryAt = now;
    const point: HistoryPoint = { t: now, temps: {}, rpm: {}, pwm: {} };
    for (const [id, value] of Object.entries(temps) as [HardwareId, number][]) {
      if (value !== undefined && Number.isFinite(value)) point.temps[id] = value;
    }
    for (const output of engine?.outputs ?? []) {
      point.pwm[output.id] = output.pwm;
      if (output.rpm !== null) point.rpm[output.id] = output.rpm;
    }
    try {
      this.opts.repos.history.append(point);
    } catch (err) {
      log.throttled('history-write', 300_000, 'error', 'Écriture de l’historique impossible', { error: err });
      this.opts.repos.alerts.raise({
        type: 'DATABASE_ERROR', level: 'warning', targetKind: 'hardware', targetId: 'database',
        targetLabel: 'Base de données', message: 'Écriture de l’historique impossible',
        recommendation: 'Vérifier l’espace disque et les permissions sur /var/lib/pcia-control-center.',
      });
    }
  }

  private purge(): void {
    const cutoff = Date.now() - this.config.history.retentionHours * 3600_000;
    try {
      const removed = this.opts.repos.history.purgeOlderThan(cutoff);
      this.opts.repos.events.purgeOlderThan(Date.now() - 7 * 24 * 3600_000);
      this.opts.repos.alerts.purgeOlderThan(Date.now() - 7 * 24 * 3600_000);
      if (removed > 0) log.debug('Purge de l’historique', { removed, cutoff });
    } catch (err) {
      log.error('Purge impossible', { error: err });
    }
  }

  // =====================================================================
  // Accès
  // =====================================================================

  snapshot(): ServerSnapshot {
    return this.lastSnapshot ?? this.rebuild();
  }

  /** Snapshot recalculé immédiatement (après une action utilisateur). */
  refresh(): ServerSnapshot {
    return this.rebuild();
  }

  /** Relit toutes les sources avant de recalculer.
   *
   *  Plus coûteux que `refresh()` : réservé aux actions qui changent l'état du
   *  système observé (scénario de démonstration, rafraîchissement explicite),
   *  où attendre le prochain cycle de collecte donnerait une vue périmée. */
  async refreshSources(): Promise<ServerSnapshot> {
    this.opts.env.demo?.step();
    this.inventory.sampleFast();
    await Promise.all([
      this.runDiscovery(),
      this.inventory.sampleGpus(),
      this.inventory.sampleStorage(),
    ]);
    return this.rebuild();
  }

  hardwareInventory(): HardwareInventory {
    return this.inventory;
  }

  discoveryTracker(): DiscoveryTracker {
    return this.tracker;
  }

  detectedServiceList(includeHidden: boolean): DetectedService[] {
    return includeHidden ? this.detectedServices : this.detectedServices.filter((s) => !s.hiddenByDefault);
  }

  detectedConnectionList(): DetectedConnection[] {
    return this.detectedConnections;
  }

  calibrationRecords(): CalibrationRecord[] {
    return this.opts.repos.calibration.list();
  }

  runtimeEnv(): RuntimeEnv {
    return this.opts.env;
  }

  /** Services et connexions complets, masqués compris (vue « tout afficher »). */
  fullMerge(includeHidden: boolean, includeLowConfidence: boolean) {
    return this.tracker.merge(
      this.detectedServices,
      this.detectedConnections,
      { services: this.opts.repos.services, connections: this.opts.repos.connections },
      { includeHidden, includeLowConfidence },
    );
  }
}
