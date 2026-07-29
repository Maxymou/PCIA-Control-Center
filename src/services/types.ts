/** Contrat de la couche de données du front-end.
 *
 *  Deux implémentations respectent ce contrat :
 *   - `MockDataProvider`  : moteur de simulation local (aucun back-end requis) ;
 *   - `ApiDataProvider`   : API REST + WebSocket du back-end PCIA.
 *
 *  Les composants ne connaissent que ce contrat : brancher ou débrancher le
 *  back-end ne demande aucune modification de l'interface.
 */

import type {
  EventCategory, FanConfig, FanId, FanProfile, Severity, Snapshot,
} from '../types';

/** Déclencheurs du panneau de démonstration. */
export interface DemoActions {
  heatUpV100(): void;
  blockFan(): void;
  stopService(): void;
  loseConnection(): void;
  detectNewService(): void;
  conflictingDetection(): void;
  toggleGtx(): void;
  newAlert(): void;
  backToNormal(): void;
  toggleBackend(): void;
}

/** Configuration récupérée au démarrage quand un vrai back-end est présent. */
export interface InitialConfig {
  fanConfigs: FanConfig[];
  builtinProfiles: FanProfile[];
  customProfiles: FanProfile[];
  activeProfileId: string;
}

export interface LogEventInput {
  category: EventCategory;
  level: Severity;
  targetLabel: string;
  message: string;
}

/** Nature de la source de données, affichée dans l'en-tête. */
export type ProviderKind = 'mock' | 'api';

export interface DataService {
  /** Identifie la source réellement utilisée. */
  readonly kind: ProviderKind;

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
  logEvent(e: LogEventInput): void;
  addProfileMarker(label: string): void;

  // Panneau de démonstration
  demo: DemoActions;

  /** Configuration initiale à charger dans le store (back-end réel uniquement). */
  loadInitialConfig?(): Promise<InitialConfig | null>;

  /** Persistance des préférences d'interface (disposition, filtres…). */
  loadUiState?(): Promise<Record<string, unknown> | null>;
  saveUiState?(state: Record<string, unknown>): Promise<void>;

  /** Dernière erreur réseau, pour l'affichage d'état. */
  lastError?(): string | null;
}

/** Snapshot vide, utilisé avant la première réponse du back-end. */
export function emptySnapshot(): Snapshot {
  return {
    time: Date.now(),
    backendConnected: false,
    services: [],
    connections: [],
    conflicts: [],
    hardware: [],
    fans: [],
    alerts: [],
    events: [],
    history: [],
    markers: [],
  };
}
