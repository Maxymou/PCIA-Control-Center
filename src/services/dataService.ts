/** COUCHE DE SERVICE — point de branchement unique entre l'interface et les données.
 *
 *  L'objet `dataService` exporté ici est un **proxy** : il délègue à la source
 *  effectivement retenue au démarrage.
 *
 *    ApiDataProvider   → back-end PCIA détecté sur la même origine ;
 *    MockDataProvider  → aucun back-end joignable (démonstration hors ligne).
 *
 *  Les composants importent toujours `dataService` : la bascule est invisible
 *  pour eux. Le choix est journalisé et exposé par `providerInfo()`.
 */

import type { FanConfig, FanId, Snapshot } from '../types';
import { ApiDataProvider } from './apiProvider';
import { mockProvider } from './mockProvider';
import { api } from './apiClient';
import type {
  CalibrationApi, DataService, DemoActions, FanCommands, InitialConfig, LogEventInput, ProviderKind,
} from './types';

export type {
  CalibrationApi, CalibrationIdentificationInput, CalibrationOverview,
  DataService, DemoActions, FanCommands, InitialConfig,
} from './types';

interface HealthResponse {
  status: string;
  version: string;
  mode: 'hardware' | 'demo';
  fanEngineOnline: boolean;
}

export interface ProviderInfo {
  kind: ProviderKind;
  /** Mode annoncé par le back-end ; `mock` en simulation locale. */
  mode: 'hardware' | 'demo' | 'mock';
  version: string | null;
  /** Raison du repli sur la simulation, le cas échéant. */
  fallbackReason: string | null;
}

let active: DataService = mockProvider;
let info: ProviderInfo = { kind: 'mock', mode: 'mock', version: null, fallbackReason: 'Initialisation' };
let initialised = false;

export function providerInfo(): ProviderInfo {
  return info;
}

/** Détecte le back-end et choisit la source de données. À appeler une fois au boot. */
export async function initDataService(): Promise<ProviderInfo> {
  if (initialised) return info;
  initialised = true;

  const forced = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PCIA_PROVIDER;
  if (forced === 'mock') {
    info = { kind: 'mock', mode: 'mock', version: null, fallbackReason: 'Forcé par VITE_PCIA_PROVIDER=mock' };
    return info;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const health = await api.get<HealthResponse>('/api/health', controller.signal);
    clearTimeout(timeout);
    if (health?.status === 'ok') {
      active = new ApiDataProvider();
      info = { kind: 'api', mode: health.mode, version: health.version, fallbackReason: null };
      return info;
    }
    info = {
      kind: 'mock', mode: 'mock', version: null,
      fallbackReason: 'Le back-end a répondu de façon inattendue.',
    };
  } catch (err) {
    // Aucun back-end : l'application reste pleinement utilisable en simulation.
    info = {
      kind: 'mock', mode: 'mock', version: null,
      fallbackReason: `Back-end injoignable (${(err as Error).message}).`,
    };
  }
  return info;
}

/** Proxy stable : les composants gardent la même référence après la bascule. */
export const dataService: DataService = {
  get kind(): ProviderKind {
    return active.kind;
  },
  start: () => active.start(),
  subscribe: (listener: (s: Snapshot) => void) => active.subscribe(listener),
  getSnapshot: () => active.getSnapshot(),

  pushFanConfigs: (configs: FanConfig[]) => active.pushFanConfigs(configs),
  startFanTest: (id: FanId, seconds: number) => active.startFanTest(id, seconds),
  stopFanTest: (id: FanId) => active.stopFanTest(id),

  ackAlert: (id: string) => active.ackAlert(id),
  snoozeAlert: (id: string, minutes: number) => active.snoozeAlert(id, minutes),
  unsnoozeAlert: (id: string) => active.unsnoozeAlert(id),

  resolveConflict: (id: string, accept: boolean) => active.resolveConflict(id, accept),

  logEvent: (e: LogEventInput) => active.logEvent(e),
  addProfileMarker: (label: string) => active.addProfileMarker(label),

  // Les déclencheurs de démonstration sont résolus à l'appel, pas à l'import.
  demo: new Proxy({} as DemoActions, {
    get: (_target, prop: string) => () => {
      const action = (active.demo as unknown as Record<string, (() => void) | undefined>)[prop];
      action?.();
    },
  }),

  // Résolus à l'appel : la source peut avoir changé depuis l'import. Absents en
  // simulation locale — l'interface le détecte et l'annonce plutôt que de feindre.
  get fanCommands(): FanCommands | undefined {
    return active.fanCommands;
  },
  get calibration(): CalibrationApi | undefined {
    return active.calibration;
  },

  loadInitialConfig: (): Promise<InitialConfig | null> =>
    active.loadInitialConfig ? active.loadInitialConfig() : Promise.resolve(null),
  loadUiState: () => (active.loadUiState ? active.loadUiState() : Promise.resolve(null)),
  saveUiState: (state: Record<string, unknown>) =>
    active.saveUiState ? active.saveUiState(state) : Promise.resolve(),
  lastError: () => (active.lastError ? active.lastError() : null),
};
