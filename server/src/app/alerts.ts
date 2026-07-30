/** Évaluation des alertes à partir de l'état courant.
 *
 *  Une alerte reste **active tant que la cause existe**, même acquittée.
 *  Les alertes issues du moteur de ventilation sont produites par le moteur
 *  lui-même (il ne dépend pas de l'API) ; on traite ici le matériel, les
 *  services, les connexions et la santé du back-end.
 */

import type { AppConfig } from '../config.js';
import type {
  Connection, FanEngineState, HardwareItem, Service,
} from '../contract.js';
import type { AlertsRepo, AlertType, EventsRepo } from '../db/repositories.js';

export interface AlertEvaluationInput {
  hardware: HardwareItem[];
  services: Service[];
  connections: Connection[];
  fanEngine: { online: boolean; lastHeartbeat: number | null; state: FanEngineState | null };
  storageHealth: { healthy: boolean; detail?: string } | null;
  conflicts: { connectionId: string }[];
}

export interface AlertEvaluationResult {
  created: number;
  resolved: number;
}

const TEMP_RECOMMENDATION = 'Vérifier la ventilation associée et la charge du composant.';

export class AlertEvaluator {
  constructor(
    private config: AppConfig,
    private alerts: AlertsRepo,
    private events: EventsRepo,
  ) {}

  evaluate(input: AlertEvaluationInput): AlertEvaluationResult {
    let created = 0;
    let resolved = 0;

    const raise = (
      type: AlertType,
      params: Parameters<AlertsRepo['raise']>[0],
      eventLevel: 'warning' | 'critical' = 'warning',
    ) => {
      const res = this.alerts.raise({ ...params, type });
      if (res.created) {
        created++;
        this.events.append({
          category: params.targetKind === 'hardware' ? 'temperature'
            : params.targetKind === 'service' ? 'service'
              : params.targetKind === 'connection' ? 'connection' : 'fan',
          level: eventLevel === 'critical' ? 'critical' : 'warning',
          targetLabel: params.targetLabel,
          message: params.message,
        });
      }
    };

    const resolve = (kind: Parameters<AlertsRepo['resolve']>[0], id: string, type?: AlertType) => {
      resolved += this.alerts.resolve(kind, id, type).length;
    };

    // ---------- Matériel : températures et santé ----------
    for (const item of input.hardware) {
      if (!item.installed) {
        // Un GPU attendu mais absent : information, pas alarme permanente.
        resolve('hardware', item.id, 'HIGH_TEMPERATURE');
        resolve('hardware', item.id, 'CRITICAL_TEMPERATURE');
        continue;
      }
      const temp = item.metrics.temp;
      const thresholds = this.config.alerts.temperatureThresholds[item.id];
      if (temp === undefined || !thresholds) {
        resolve('hardware', item.id, 'HIGH_TEMPERATURE');
        resolve('hardware', item.id, 'CRITICAL_TEMPERATURE');
        continue;
      }
      const [warn, critical] = thresholds;
      if (temp >= critical) {
        resolve('hardware', item.id, 'HIGH_TEMPERATURE');
        raise('CRITICAL_TEMPERATURE', {
          type: 'CRITICAL_TEMPERATURE', level: 'critical', targetKind: 'hardware',
          targetId: item.id, targetLabel: item.name, message: 'Température critique',
          value: `${temp.toFixed(1)} °C`, threshold: `${critical} °C`,
          recommendation: TEMP_RECOMMENDATION,
        }, 'critical');
      } else if (temp >= warn) {
        resolve('hardware', item.id, 'CRITICAL_TEMPERATURE');
        raise('HIGH_TEMPERATURE', {
          type: 'HIGH_TEMPERATURE', level: 'warning', targetKind: 'hardware',
          targetId: item.id, targetLabel: item.name, message: 'Température élevée',
          value: `${temp.toFixed(1)} °C`, threshold: `${warn} °C`,
          recommendation: TEMP_RECOMMENDATION,
        });
      } else {
        resolve('hardware', item.id, 'HIGH_TEMPERATURE');
        resolve('hardware', item.id, 'CRITICAL_TEMPERATURE');
      }
    }

    // ---------- Stockage ----------
    const nvme = input.hardware.find((h) => h.id === 'nvme');
    if (nvme && input.storageHealth) {
      if (!input.storageHealth.healthy) {
        raise('STORAGE_HEALTH', {
          type: 'STORAGE_HEALTH', level: 'critical', targetKind: 'hardware',
          targetId: 'nvme', targetLabel: nvme.name,
          message: 'État SMART dégradé',
          value: input.storageHealth.detail,
          recommendation: 'Sauvegarder les données et envisager le remplacement du SSD.',
        }, 'critical');
      } else {
        resolve('hardware', 'nvme', 'STORAGE_HEALTH');
      }
    }

    // ---------- Services ----------
    for (const service of input.services) {
      const label = service.displayName ?? service.name;
      switch (service.status) {
        case 'crashed':
        case 'error':
          resolve('service', service.id, 'SERVICE_UNREACHABLE');
          raise('SERVICE_STOPPED', {
            type: 'SERVICE_STOPPED', level: 'critical', targetKind: 'service',
            targetId: service.id, targetLabel: label,
            message: service.status === 'crashed' ? 'Arrêt inattendu du service' : 'Service en erreur',
            recommendation: service.container
              ? 'Consulter les journaux du conteneur.'
              : 'Consulter `journalctl -u` pour cette unité.',
          }, 'critical');
          break;
        case 'unreachable':
          resolve('service', service.id, 'SERVICE_STOPPED');
          raise('SERVICE_UNREACHABLE', {
            type: 'SERVICE_UNREACHABLE', level: 'critical', targetKind: 'service',
            targetId: service.id, targetLabel: label, message: 'Service inaccessible',
            recommendation: service.port
              ? `Vérifier que le service répond sur le port ${service.port}.`
              : 'Vérifier l’état du service.',
          }, 'critical');
          break;
        default:
          // Un arrêt volontaire n'est pas une anomalie.
          resolve('service', service.id, 'SERVICE_STOPPED');
          resolve('service', service.id, 'SERVICE_UNREACHABLE');
      }
    }

    // ---------- Connexions ----------
    for (const connection of input.connections) {
      const label = `${connection.sourceId} → ${connection.targetId}`;
      if (connection.status === 'lost') {
        raise('CONNECTION_LOST', {
          type: 'CONNECTION_LOST', level: 'warning', targetKind: 'connection',
          targetId: connection.id, targetLabel: label, message: 'Connexion perdue',
          recommendation: connection.port
            ? `Vérifier que le service distant répond sur le port ${connection.port}.`
            : 'Vérifier la disponibilité du service distant.',
        });
      } else {
        resolve('connection', connection.id, 'CONNECTION_LOST');
      }
    }

    // ---------- Conflits de détection ----------
    const conflictIds = new Set(input.conflicts.map((c) => c.connectionId));
    for (const id of conflictIds) {
      raise('CONNECTION_CONFLICT', {
        type: 'CONNECTION_CONFLICT', level: 'warning', targetKind: 'connection',
        targetId: id, targetLabel: 'Détection contradictoire',
        message: 'Une nouvelle détection contredit une correction manuelle',
        recommendation: 'Comparer les deux versions et choisir celle à conserver.',
      });
    }
    for (const connection of input.connections) {
      if (!conflictIds.has(connection.id)) resolve('connection', connection.id, 'CONNECTION_CONFLICT');
    }

    // ---------- Santé du moteur de ventilation ----------
    if (!input.fanEngine.online) {
      raise('FAN_CONTROLLER_OFFLINE', {
        type: 'FAN_CONTROLLER_OFFLINE', level: 'critical', targetKind: 'fan',
        targetId: 'controller', targetLabel: 'Moteur de ventilation',
        message: 'Moteur de ventilation injoignable',
        value: input.fanEngine.lastHeartbeat
          ? `Dernier signe de vie il y a ${Math.round((Date.now() - input.fanEngine.lastHeartbeat) / 1000)} s`
          : 'Aucun signe de vie',
        recommendation: 'Vérifier `systemctl status pcia-fan-control` — les ventilateurs peuvent être restés sur leur dernière consigne.',
      }, 'critical');
    } else {
      resolve('fan', 'controller', 'FAN_CONTROLLER_OFFLINE');
    }

    return { created, resolved };
  }
}
