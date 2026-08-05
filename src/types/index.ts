/** Modèles de données de PCIA Control Center.
 *  Ces types constituent le contrat entre l'interface et la couche de données
 *  (mocks aujourd'hui, API réelle demain). */

// ---------- États génériques ----------
export type Severity = 'normal' | 'warning' | 'critical' | 'unknown';

// ---------- Services ----------
export type ServiceStatus =
  | 'running'
  | 'stopped'          // arrêté volontairement
  | 'crashed'          // arrêté de façon inattendue
  | 'starting'
  | 'restarting'
  | 'unreachable'
  | 'error'
  | 'unknown'
  | 'not-installed';

export type ServiceOrigin = 'detected' | 'manual';

export type ServiceType =
  | 'ui' | 'fan-control' | 'docker' | 'llm' | 'webui'
  | 'api' | 'system' | 'proxy' | 'database' | 'other';

export interface Service {
  id: string;
  name: string;
  displayName?: string;
  type: ServiceType;
  status: ServiceStatus;
  version?: string;
  port?: number;
  address?: string;
  process?: string;
  container?: string;
  origin: ServiceOrigin;
  lastCheck: number;      // timestamp ms
  note?: string;
  isNew?: boolean;        // détecté récemment, pas encore placé
}

// ---------- Connexions ----------
export type ConnectionType =
  | 'http' | 'https' | 'openai-api' | 'websocket' | 'docker'
  | 'cuda' | 'hardware' | 'sensor' | 'pwm' | 'database'
  | 'network' | 'custom';

export type ConnectionStatus =
  | 'active' | 'degraded' | 'lost' | 'unknown' | 'new' | 'pending';

export type ConnectionOrigin = 'detected' | 'manual' | 'corrected';

export interface Connection {
  id: string;
  sourceId: string;
  targetId: string;
  type: ConnectionType;
  protocol?: string;
  port?: number;
  endpoint?: string;
  status: ConnectionStatus;
  origin: ConnectionOrigin;
  confidence?: number;      // 0..1, niveau de confiance de détection
  note?: string;
  lastActivity?: number;
  /** Données détectées d'origine, conservées après correction manuelle. */
  detectedOriginal?: Pick<Connection, 'sourceId' | 'targetId' | 'type' | 'port' | 'endpoint'>;
}

/** Conflit entre une correction utilisateur et une nouvelle détection. */
export interface ConnectionConflict {
  connectionId: string;
  detected: Pick<Connection, 'sourceId' | 'targetId' | 'type' | 'port' | 'endpoint'>;
  createdAt: number;
}

// ---------- Groupes ----------
export interface ServiceGroup {
  id: string;
  name: string;
  serviceIds: string[];
  color?: string;          // couleur d'accent discrète
  note?: string;
  collapsed?: boolean;
}

// ---------- Matériel ----------
export type HardwareId =
  | 'cpu' | 'nvme' | 'v100-1' | 'v100-2' | 'gtx1080'
  | 'case-front' | 'case-rear' | 'motherboard';

export interface HardwareItem {
  id: HardwareId;
  name: string;
  kind: 'cpu' | 'gpu' | 'storage' | 'case' | 'board';
  model?: string;
  installed: boolean;
  pcieSlot?: string;
  metrics: HardwareMetrics;
}

export interface HardwareMetrics {
  temp?: number;          // °C
  load?: number;          // %
  freq?: number;          // MHz
  power?: number;         // W
  memUsed?: number;       // Go
  memTotal?: number;      // Go
  capacity?: number;      // Go
  used?: number;          // Go
  health?: number;        // %
  activity?: number;      // %
  status: Severity;
}

// ---------- Ventilation ----------
export type FanId = 'CPU_FAN1' | 'SYS_FAN1' | 'SYS_FAN2' | 'SYS_FAN3' | 'SYS_FAN4';
export type FanMode = 'auto' | 'manual' | 'full' | 'test';

export type SensorRef =
  | { kind: 'single'; source: HardwareId }
  | { kind: 'hottest-gpu' }
  | { kind: 'max'; sources: HardwareId[] }
  | { kind: 'avg'; sources: HardwareId[] };

export interface CurvePoint { temp: number; pwm: number; }
export type FanCurve = CurvePoint[];   // 2 à 6 points, triés par température

export interface FanConfig {
  id: FanId;
  displayName: string;
  assignedHardware: HardwareId | 'none' | 'custom';
  customHardwareLabel?: string;
  sensor: SensorRef;
  mode: FanMode;
  manualPwm: number;        // consigne en mode manuel
  minPwm: number;           // seuil minimum de fonctionnement
  warnRpm: number;          // seuils d'alerte
  curve: FanCurve;          // courbe active (mode auto)
}

/** D'où vient la vitesse affichée.
 *
 *  Cette distinction est une exigence de sécurité, pas un confort d'affichage :
 *  un « 0 RPM » inventé parce que la mesure manque ressemble à un ventilateur
 *  arrêté, et un chiffre simulé ressemble à une mesure. Les trois cas doivent
 *  rester discernables jusque dans l'interface. */
export type RpmSource = 'measured' | 'simulated' | 'unavailable';

export interface FanLive {
  id: FanId;
  pwm: number;              // consigne appliquée
  /** `null` = aucune mesure exploitable. Jamais remplacé par 0. */
  rpm: number | null;
  rpmSource: RpmSource;
  refTemp: number;
  status: Severity;
  testRemaining?: number;   // secondes restantes en mode test
  stalled?: boolean;
}

// ---------- Profils ----------
export interface FanProfile {
  id: string;
  name: string;
  builtin: boolean;
  curves: Record<FanId, FanCurve>;
}

// ---------- Alertes & événements ----------
export type AlertLevel = 'warning' | 'critical' | 'info';

export interface Alert {
  id: string;
  level: AlertLevel;
  time: number;
  targetKind: 'service' | 'connection' | 'hardware' | 'fan';
  targetId: string;
  targetLabel: string;
  message: string;
  value?: string;
  threshold?: string;
  recommendation?: string;
  acknowledged: boolean;
  snoozedUntil?: number;
  active: boolean;
}

export type EventCategory =
  | 'temperature' | 'fan' | 'service' | 'connection'
  | 'hardware' | 'profile' | 'curve' | 'alert' | 'config';

export interface AppEvent {
  id: string;
  time: number;
  category: EventCategory;
  level: Severity;
  targetLabel: string;
  message: string;
}

// ---------- Historique ----------
export interface HistoryPoint {
  t: number;                                   // timestamp ms
  temps: Partial<Record<HardwareId, number>>;
  rpm: Partial<Record<FanId, number>>;
  pwm: Partial<Record<FanId, number>>;
}

export interface HistoryMarker {
  t: number;
  label: string;
  kind: 'alert' | 'event' | 'profile';
}

// ---------- Informations du back-end ----------
/** Mode d'exécution réel du back-end. `mock` = simulation locale au navigateur. */
export type BackendMode = 'hardware' | 'demo';

/** Ce que le système sait réellement faire : l'interface désactive le reste. */
export interface BackendCapabilities {
  canReadTemperature: boolean;
  canReadRpm: boolean;
  canWritePwm: boolean;
  canReturnToBios: boolean;
  canDetectServices: boolean;
  canDetectConnections: boolean;
  canReadGpuPower: boolean;
  canReadStorageSmart: boolean;
  canControlFans: boolean;
  tools: Record<string, boolean>;
}

export interface BackendSystemStatus {
  version: string;
  mode: BackendMode;
  /** Mode matériel avec des sources manquantes (supervision partielle). */
  degraded: boolean;
  degradedReasons: string[];
  startedAt: number;
  kernel: string;
  distribution: string;
  hostname: string;
  fanEngine: {
    online: boolean;
    lastHeartbeat: number | null;
    embedded: boolean;
    failsafe: boolean;
  };
  capabilities: BackendCapabilities;
}

/** Qui pilote effectivement une sortie de ventilation. */
export type FanControlState =
  | 'BIOS_CONTROLLED' | 'SOFTWARE_STARTING' | 'SOFTWARE_CONTROLLED'
  | 'FAILSAFE' | 'RETURNING_TO_BIOS' | 'UNSUPPORTED' | 'ERROR';

export type CalibrationState =
  | 'NOT_CALIBRATED' | 'DETECTED' | 'IDENTIFIED' | 'RPM_CONFIRMED'
  | 'SOFTWARE_CONTROL_VALIDATED' | 'BIOS_RETURN_VALIDATED' | 'AUTHORIZED'
  | 'RESTRICTED' | 'FAILED';

export interface FanOutputState {
  id: FanId;
  controlState: FanControlState;
  calibrationState: CalibrationState;
  pwm: number;
  requestedPwm: number;
  rpm: number | null;
  /** Provenance de `rpm` — mesure réelle, simulation, ou rien. */
  rpmSource: RpmSource;
  refTemp: number | null;
  sensorLostSince: number | null;
  stalled: boolean;
  stalledSince: number | null;
  testRemainingS: number | null;
  lastWriteError: string | null;
  writeFailures: number;
  /** Sortie PWM réellement pilotée (contrôle logiciel). */
  boundOutputKey: string | null;
  /** Sortie PWM observée — identique à `boundOutputKey` sous contrôle logiciel,
   *  renseignée aussi sous contrôle BIOS quand le mappage la désigne. */
  monitorOutputKey: string | null;
  /** Origine de la liaison : configuration déclarative ou calibration. */
  mappingSource: 'config' | 'calibration' | 'none';
  /** Nom du connecteur physique (CPU_FAN1, SYS_FAN3…). */
  connectorLabel: string | null;
  /** Chemin sysfs courant de la sortie — informatif, jamais une identité. */
  hwmonPath: string | null;
  severity: Severity;
}

/** Connecteur présent sur la carte mais déclaré non raccordé.
 *
 *  Il n'est ni piloté, ni calibrable, ni surveillé : il est seulement *connu*,
 *  pour que l'inventaire soit complet et qu'un `0 RPM` légitime ne soit pas pris
 *  pour un ventilateur bloqué. */
export interface UnconnectedOutputState {
  /** Nom du connecteur (PUMP_FAN1, AIO_PUMP…). */
  label: string;
  /** Sortie PWM correspondante, ou `null` si la déclaration ne résout pas. */
  outputKey: string | null;
  /** Vitesse relevée. `0` est une mesure réelle : rien n'est branché. */
  rpm: number | null;
  rpmSource: RpmSource;
  hwmonPath: string | null;
}

// ---------- Découverte matérielle et calibration ----------
/** Ces types décrivent ce que le moteur de ventilation observe réellement dans
 *  `/sys`. Ils sont définis ici — et non côté serveur — pour que le front-end et
 *  le back-end partagent **une seule source de vérité** : `server/src/contract.ts`
 *  les ré-exporte tels quels, comme il le fait déjà pour `FanOutputState`. */

export type RpmValidationResult =
  | 'CONFIRMED' | 'PROBABLE' | 'NOT_AVAILABLE' | 'INCONSISTENT' | 'FAILED';

export type BiosReturnResult =
  | 'CONFIRMED' | 'PROBABLE' | 'NOT_CONFIRMED' | 'IMPOSSIBLE' | 'UNKNOWN';

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

/** Étapes de l'assistant de calibration, telles que le moteur les nomme. */
export type CalibrationStep =
  | 'idle' | 'identify' | 'test-rpm' | 'detect-minimum'
  | 'test-software-control' | 'test-bios-return';

/** Observation d'un tachymètre pendant l'identification physique. */
export interface TachObservation {
  tachKey: string;
  tachIndex: number;
  /** RPM au palier bas puis au palier haut. */
  rpmLow: number | null;
  rpmHigh: number | null;
  /** Écart relatif — sert à identifier le tachymètre réellement lié. */
  delta: number;
}

/** Session de calibration en cours, diffusée par le moteur.
 *  La conformité avec la structure réellement produite par
 *  `server/src/fan/calibration.ts` est vérifiée à la compilation dans
 *  `server/src/contract.ts` : toute divergence casse le build. */
export interface CalibrationSession {
  fanId: FanId;
  outputKey: string;
  step: CalibrationStep;
  busy: boolean;
  startedAt: number;
  /** Progression 0–1 de l'étape en cours. */
  progress: number;
  message: string;
  /** État sauvegardé avant toute écriture — cible de la restauration. */
  initial: {
    enableMode: number | null;
    pwmPercent: number | null;
    rpm: number | null;
    refTemp: number | null;
    savedAt: number;
  };
  lastObservations: TachObservation[];
  lastError: string | null;
  /** Résultat de la dernière étape, à afficher dans l'assistant. */
  lastResult: Record<string, unknown> | null;
}

// ---------- Snapshot global ----------
export interface Snapshot {
  time: number;
  /** Faux quand le front-end a perdu le contact avec le back-end. */
  backendConnected: boolean;
  services: Service[];
  connections: Connection[];
  conflicts: ConnectionConflict[];
  hardware: HardwareItem[];
  fans: FanLive[];
  alerts: Alert[];
  events: AppEvent[];
  history: HistoryPoint[];
  markers: HistoryMarker[];

  /** Renseigné par le vrai back-end ; absent en simulation locale. */
  system?: BackendSystemStatus;
  /** État BIOS/logiciel des sorties — absent en simulation locale. */
  fanOutputs?: FanOutputState[];
  /** Connecteurs déclarés non raccordés — absents en simulation locale. */
  unconnectedOutputs?: UnconnectedOutputState[];
  /** Enregistrements de calibration — absents en simulation locale. */
  calibration?: CalibrationRecord[];
}
