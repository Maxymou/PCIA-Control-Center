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
  CalibrationRecord, CalibrationSession, EventCategory, FanConfig, FanId, FanProfile,
  HardwareId, HwmonDiscovery, Severity, Snapshot,
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

// =====================================================================
// Commandes matérielles — toujours asynchrones
// =====================================================================

/** Commandes de contrôle d'une sortie de ventilation.
 *
 *  Contrairement aux méthodes historiques (`startFanTest`, `ackAlert`…) qui sont
 *  « tire et oublie », **ces commandes touchent directement le matériel** :
 *  elles retournent une promesse et **rejettent** (`ApiError`) si le serveur
 *  refuse. L'interface ne doit jamais annoncer un succès avant la résolution. */
export interface FanCommands {
  /** Rend la sortie au BIOS et vérifie que la restitution a bien eu lieu. */
  returnToBios(id: FanId): Promise<void>;
  /** Reprend le contrôle logiciel d'une sortie calibrée et autorisée. */
  takeSoftwareControl(id: FanId): Promise<void>;
  /** Force la sortie à 100 % jusqu'à annulation explicite. */
  forceMax(id: FanId): Promise<void>;
  clearForceMax(id: FanId): Promise<void>;
}

/** Confirmation utilisateur de l'étape d'identification physique. */
export interface CalibrationIdentificationInput {
  assignedHardware: HardwareId | 'none' | 'custom';
  customLabel?: string;
  /** Tachymètre confirmé comme lié à cette sortie ; `null` si aucun. */
  tachKey?: string | null;
  /** L'utilisateur n'a pas pu déterminer quel ventilateur a réagi. */
  inconclusive?: boolean;
}

/** État complet de la calibration, tel que renvoyé par `GET /api/calibration`. */
export interface CalibrationOverview {
  records: CalibrationRecord[];
  sessions: CalibrationSession[];
  engineOnline: boolean;
  requireBiosReturnValidation: boolean;
}

/** Assistant de calibration — chaque appel atteint le matériel réel.
 *
 *  Les étapes longues répondent `202` : le serveur rend la main immédiatement et
 *  la progression arrive par WebSocket (`calibration.updated`) puis par
 *  `load()`. L'interface ne déduit jamais un résultat : elle affiche ce que le
 *  moteur publie. */
export interface CalibrationApi {
  load(): Promise<CalibrationOverview>;
  /** Inventaire des contrôleurs et sorties — aucune prise de contrôle. */
  discover(): Promise<HwmonDiscovery>;
  start(fanId: FanId, outputKey: string): Promise<void>;
  identify(fanId: FanId): Promise<void>;
  confirmIdentification(fanId: FanId, input: CalibrationIdentificationInput): Promise<void>;
  testRpm(fanId: FanId): Promise<void>;
  detectMinimum(fanId: FanId): Promise<void>;
  testSoftwareControl(fanId: FanId): Promise<void>;
  testBiosReturn(fanId: FanId): Promise<void>;
  authorize(fanId: FanId, acceptRestricted?: boolean): Promise<void>;
  cancel(fanId: FanId): Promise<void>;
  /** Priorité absolue : restaure l'état initial sans validation préalable. */
  emergencyStop(fanId: FanId): Promise<void>;
  reset(fanId: FanId): Promise<void>;
}

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

  /** Commandes matérielles directes — **absentes en simulation locale**.
   *  L'interface teste leur présence et annonce « indisponible sans back-end »
   *  plutôt que de simuler une action qui n'atteindrait aucun matériel. */
  fanCommands?: FanCommands;

  /** Assistant de calibration — **absent en simulation locale**, pour la même
   *  raison : une calibration ne peut pas être maquettée. */
  calibration?: CalibrationApi;

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
