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

export interface FanLive {
  id: FanId;
  pwm: number;              // consigne appliquée
  rpm: number;
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

// ---------- Snapshot global ----------
export interface Snapshot {
  time: number;
  backendConnected: boolean;   // simulé
  services: Service[];
  connections: Connection[];
  conflicts: ConnectionConflict[];
  hardware: HardwareItem[];
  fans: FanLive[];
  alerts: Alert[];
  events: AppEvent[];
  history: HistoryPoint[];
  markers: HistoryMarker[];
}
