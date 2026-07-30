/** Source de données simulée (aucun back-end requis).
 *
 *  Conservée telle quelle pour le mode démonstration hors ligne : ouvrir
 *  `index.html` servi par Vite suffit à faire tourner l'application complète.
 *  Le moteur (`src/mocks/engine.ts`) n'est pas modifié.
 */

import { engine } from '../mocks/engine';
import { seedFanConfigs, seedProfiles } from '../mocks/seed';
import type { DataService, InitialConfig } from './types';

export const mockProvider: DataService = {
  kind: 'mock',

  start: () => engine.start(),
  subscribe: (listener) => engine.subscribe(listener),
  getSnapshot: () => engine.getSnapshot(),

  pushFanConfigs: (configs) => engine.setFanConfigs(configs),
  startFanTest: (id, seconds) => engine.startFanTest(id, seconds),
  stopFanTest: (id) => engine.stopFanTest(id),

  ackAlert: (id) => engine.ackAlert(id),
  snoozeAlert: (id, minutes) => engine.snoozeAlert(id, minutes),
  unsnoozeAlert: (id) => engine.unsnoozeAlert(id),

  resolveConflict: (id, accept) => engine.resolveConflict(id, accept),

  logEvent: (e) => engine.logEvent(e),
  addProfileMarker: (label) => engine.addProfileMarker(label),

  demo: engine.demo,

  async loadInitialConfig(): Promise<InitialConfig> {
    // En simulation locale, la configuration vient des données d'amorçage.
    return {
      fanConfigs: structuredClone(seedFanConfigs),
      builtinProfiles: structuredClone(seedProfiles),
      customProfiles: [],
      activeProfileId: 'p-balanced',
    };
  },
};
