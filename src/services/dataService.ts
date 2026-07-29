/** COUCHE DE SERVICE — contrat entre l'interface et la source de données.
 *
 *  Aujourd'hui : implémentation branchée sur le moteur de simulation (mocks).
 *  Demain : réimplémenter ce même contrat avec fetch() / WebSocket vers le
 *  vrai back-end, sans modifier les composants React.
 */

import type { FanConfig, FanId, Snapshot } from '../types';
import { engine } from '../mocks/engine';

export interface DataService {
  start(): void;
  subscribe(listener: (s: Snapshot) => void): () => void;
  getSnapshot(): Snapshot;

  // Ventilation
  pushFanConfigs(configs: FanConfig[]): void;
  startFanTest(id: FanId, seconds: number): void;
  stopFanTest(id: FanId): void;

  // Alertes
  ackAlert(id: string): void;
  snoozeAlert(id: string, minutes: number): void;
  unsnoozeAlert(id: string): void;

  // Conflits de détection
  resolveConflict(connectionId: string, acceptDetection: boolean): void;

  // Journalisation côté interface (édition de courbe, changement de profil…)
  logEvent(e: { category: import('../types').EventCategory; level: import('../types').Severity; targetLabel: string; message: string }): void;
  addProfileMarker(label: string): void;

  // Panneau de démonstration
  demo: typeof engine.demo;
}

/** Implémentation simulée. */
export const dataService: DataService = {
  start: () => engine.start(),
  subscribe: (l) => engine.subscribe(l),
  getSnapshot: () => engine.getSnapshot(),
  pushFanConfigs: (c) => engine.setFanConfigs(c),
  startFanTest: (id, s) => engine.startFanTest(id, s),
  stopFanTest: (id) => engine.stopFanTest(id),
  ackAlert: (id) => engine.ackAlert(id),
  snoozeAlert: (id, m) => engine.snoozeAlert(id, m),
  unsnoozeAlert: (id) => engine.unsnoozeAlert(id),
  resolveConflict: (id, a) => engine.resolveConflict(id, a),
  logEvent: (e) => engine.logEvent(e),
  addProfileMarker: (l) => engine.addProfileMarker(l),
  demo: engine.demo,
};
