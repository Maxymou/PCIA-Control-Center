/** Contrat back-end.
 *
 *  Réutilise tels quels les types du front-end (`src/types/index.ts`) — ils sont
 *  la référence fonctionnelle — et ajoute les notions que l'interface actuelle
 *  n'expose pas encore : état BIOS/logiciel des sorties, calibration, capacités,
 *  messages WebSocket.
 */

export type {
  Alert,
  AlertLevel,
  AppEvent,
  BackendCapabilities,
  BackendMode,
  BackendSystemStatus,
  BiosReturnResult,
  CalibrationRecord,
  CalibrationSession,
  CalibrationStep,
  Connection,
  ControllerIdentity,
  DiscoveredPwmOutput,
  DiscoveredTempSensor,
  HwmonDiscovery,
  RpmValidationResult,
  TachObservation,
  ConnectionConflict,
  ConnectionOrigin,
  ConnectionStatus,
  ConnectionType,
  CurvePoint,
  EventCategory,
  FanConfig,
  FanCurve,
  FanId,
  FanLive,
  FanMode,
  FanProfile,
  HardwareId,
  HardwareItem,
  HardwareMetrics,
  HistoryMarker,
  HistoryPoint,
  SensorRef,
  Service,
  ServiceGroup,
  ServiceOrigin,
  ServiceStatus,
  ServiceType,
  Severity,
  Snapshot,
} from '../../src/types/index.js';

import type {
  BackendCapabilities, BackendSystemStatus, CalibrationState as SharedCalibrationState,
  FanControlState as SharedFanControlState, FanCurve, FanId, FanOutputState as SharedFanOutputState,
  CalibrationRecord, CalibrationSession, Snapshot,
} from '../../src/types/index.js';
import type { CalibrationSession as EngineCalibrationSession } from './fan/calibration.js';

// ---------- Sorties de ventilation ----------

export const FAN_IDS = ['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'] as const;

/** Qui pilote effectivement la sortie, à cet instant.
 *  Défini côté front-end (src/types) pour n'avoir qu'une seule source de vérité. */
export type FanControlState = SharedFanControlState;

/** Progression de l'assistant de calibration pour une sortie. */
export type CalibrationState = SharedCalibrationState;

/** Découverte hwmon, résultats de validation et enregistrements de calibration :
 *  définis dans `src/types/index.ts` et ré-exportés ci-dessus, pour que le
 *  front-end et le back-end partagent exactement les mêmes structures. */

/** Garde de conformité — vérifiée à la compilation, effacée à l'exécution.
 *
 *  Le moteur de ventilation (`fan/calibration.ts`) reste la source de la session
 *  réellement produite ; il n'est pas modifié. Cette assertion garantit que la
 *  structure partagée avec le front-end lui reste identique : toute divergence
 *  introduite plus tard casse le build au lieu de produire silencieusement une
 *  interface d'assistant désynchronisée du moteur. */
type Conforms<Actual extends Expected, Expected> = Actual;
export type _CalibrationSessionConformance =
  Conforms<EngineCalibrationSession, CalibrationSession>;

/** État publié par le moteur de ventilation (fichier + WebSocket). */
export interface FanEngineState {
  /** Horodatage du dernier cycle complet. */
  heartbeat: number;
  pid: number;
  mode: 'hardware' | 'demo';
  loopIntervalMs: number;
  /** Vrai si au moins une sortie est en FAILSAFE. */
  failsafe: boolean;
  outputs: FanOutputState[];
  warnings: string[];
}

/** État publié pour chaque sortie (défini côté front-end, cf. src/types). */
export type FanOutputState = SharedFanOutputState;

/** Ce que le système sait faire réellement, pour désactiver proprement l'UI. */
export type Capabilities = BackendCapabilities;

export type SystemStatus = BackendSystemStatus;

// ---------- Snapshot enrichi ----------

/** Ce que renvoie `/api/snapshot` et le WebSocket : le `Snapshot` attendu par le
 *  front-end, plus les champs additionnels que les nouvelles vues peuvent lire.
 *  Les composants existants ignorent simplement les champs supplémentaires. */
export type ServerSnapshot = Snapshot & {
  system: SystemStatus;
  fanOutputs: FanOutputState[];
  calibration: CalibrationRecord[];
};

// ---------- Messages WebSocket ----------

export const WS_SCHEMA_VERSION = 1;

export type WsMessageType =
  | 'snapshot'
  | 'system.status'
  | 'hardware.updated'
  | 'sensor.updated'
  | 'gpu.updated'
  | 'fan.updated'
  | 'fan.mode_changed'
  | 'fan.curve_changed'
  | 'service.updated'
  | 'connection.updated'
  | 'connection.conflict'
  | 'alert.created'
  | 'alert.updated'
  | 'alert.resolved'
  | 'event.created'
  | 'calibration.updated'
  | 'backend.health'
  | 'fan_controller.health'
  | 'pong';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  timestamp: number;
  schema: number;
  payload: T;
}

// ---------- Profils intégrés ----------

export interface BuiltinProfileDefinition {
  id: string;
  name: string;
  /** Courbe par défaut, appliquée à toutes les sorties sans réglage spécifique. */
  defaultCurve: FanCurve;
  /** Courbes spécifiques (ex. sorties dédiées aux V100 passives). */
  overrides?: Partial<Record<FanId, FanCurve>>;
}
