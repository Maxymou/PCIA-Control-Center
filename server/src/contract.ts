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
  Connection,
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
  HardwareId, Snapshot,
} from '../../src/types/index.js';

// ---------- Sorties de ventilation ----------

export const FAN_IDS = ['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'] as const;

/** Qui pilote effectivement la sortie, à cet instant.
 *  Défini côté front-end (src/types) pour n'avoir qu'une seule source de vérité. */
export type FanControlState = SharedFanControlState;

/** Progression de l'assistant de calibration pour une sortie. */
export type CalibrationState = SharedCalibrationState;

export type RpmValidationResult = 'CONFIRMED' | 'PROBABLE' | 'NOT_AVAILABLE' | 'INCONSISTENT' | 'FAILED';
export type BiosReturnResult = 'CONFIRMED' | 'PROBABLE' | 'NOT_CONFIRMED' | 'IMPOSSIBLE' | 'UNKNOWN';

/** Identification stable d'un contrôleur hwmon, indépendante de l'index /sys. */
export interface ControllerIdentity {
  /** Empreinte stable calculée à partir des éléments ci-dessous. */
  key: string;
  /** Contenu de `name` (ex. nct6798, coretemp, nvme). */
  driverName: string;
  /** Pilote noyau réel (device/driver). */
  kernelDriver: string | null;
  /** Bus (pci, platform, i2c, acpi…). */
  bus: string | null;
  /** Adresse sur le bus (ex. 0000:00:1f.3, nct6775.2592). */
  address: string | null;
  /** MODALIAS relevé dans uevent. */
  modalias: string | null;
  /** Chemin /sys courant — informatif uniquement, jamais un identifiant. */
  currentPath: string;
}

/** Une sortie PWM telle que découverte sur le système. */
export interface DiscoveredPwmOutput {
  /** Identifiant stable : `${controller.key}#pwm${index}`. */
  key: string;
  controller: ControllerIdentity;
  /** Index sysfs (pwm1 -> 1). Peut changer : jamais utilisé seul comme identité. */
  index: number;
  pwmPath: string;
  enablePath: string | null;
  /** Modes acceptés par pwmN_enable, quand ils sont énumérables. */
  supportedEnableModes: number[];
  /** Mode courant lu dans pwmN_enable (null si non exposé). */
  currentEnableMode: number | null;
  currentPwm: number | null;
  /** Entrée tachymétrique associée, si une corrélation a pu être établie. */
  tachPath: string | null;
  tachIndex: number | null;
  currentRpm: number | null;
  label: string | null;
  writable: boolean;
}

/** Capteur de température découvert. */
export interface DiscoveredTempSensor {
  key: string;
  controller: ControllerIdentity;
  index: number;
  path: string;
  label: string | null;
  valueC: number | null;
  /** Identifiant matériel du front-end auquel ce capteur a été rattaché. */
  mappedTo: HardwareId | null;
}

export interface HwmonDiscovery {
  controllers: ControllerIdentity[];
  pwmOutputs: DiscoveredPwmOutput[];
  tempSensors: DiscoveredTempSensor[];
  /** Entrées tachymétriques sans sortie PWM corrélée. */
  orphanTachs: { key: string; controller: ControllerIdentity; index: number; path: string; rpm: number | null }[];
  warnings: string[];
}

/** Enregistrement de calibration persisté pour une sortie logique. */
export interface CalibrationRecord {
  fanId: FanId;
  state: CalibrationState;
  /** Identité stable de la sortie PWM retenue. */
  outputKey: string | null;
  controllerKey: string | null;
  controllerDriver: string | null;
  controllerAddress: string | null;
  /** Index PWM/tach au moment de la calibration (informatif). */
  pwmIndex: number | null;
  tachIndex: number | null;
  /** Chemins observés lors de la calibration — informatifs, revalidés au démarrage. */
  lastPwmPath: string | null;
  lastTachPath: string | null;
  assignedHardware: HardwareId | 'none' | 'custom' | null;
  customHardwareLabel: string | null;
  rpmValidation: RpmValidationResult | null;
  /** Seuil de démarrage observé (PWM en %). */
  startupPwm: number | null;
  /** Minimum retenu après marge de sécurité (PWM en %). */
  minimumPwm: number | null;
  minRpmObserved: number | null;
  maxRpmObserved: number | null;
  softwareControlValidated: boolean;
  biosReturn: BiosReturnResult | null;
  /** Mode pwmN_enable observé comme « BIOS/automatique » pour cette sortie. */
  biosEnableMode: number | null;
  /** Mode pwmN_enable permettant le pilotage manuel. */
  manualEnableMode: number | null;
  biosVersion: string | null;
  kernelVersion: string | null;
  calibratedAt: number | null;
  notes: string | null;
  /** Invalidé si le matériel a changé depuis la calibration. */
  invalidatedReason: string | null;
}

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
