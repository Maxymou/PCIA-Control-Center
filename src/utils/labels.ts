import type {
  ConnectionStatus, ConnectionType, ConnectionOrigin,
  ServiceStatus, ServiceType, Severity, FanMode, EventCategory,
} from '../types';

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  running: 'Actif',
  stopped: 'Arrêté (volontaire)',
  crashed: 'Arrêt inattendu',
  starting: 'Démarrage…',
  restarting: 'Redémarrage…',
  unreachable: 'Inaccessible',
  error: 'En erreur',
  unknown: 'Inconnu',
  'not-installed': 'Non installé',
};

export const SERVICE_STATUS_SEVERITY: Record<ServiceStatus, Severity> = {
  running: 'normal',
  stopped: 'unknown',
  crashed: 'critical',
  starting: 'warning',
  restarting: 'warning',
  unreachable: 'critical',
  error: 'critical',
  unknown: 'unknown',
  'not-installed': 'unknown',
};

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  ui: 'Interface',
  'fan-control': 'Ventilation',
  docker: 'Docker',
  llm: 'IA / LLM',
  webui: 'Interface web',
  api: 'API',
  system: 'Système',
  proxy: 'Reverse proxy',
  database: 'Base de données',
  other: 'Autre',
};

export const SERVICE_TYPE_ICONS: Record<ServiceType, string> = {
  ui: '🖥', 'fan-control': '🌀', docker: '🐳', llm: '🧠', webui: '🌐',
  api: '🔌', system: '⚙', proxy: '🔀', database: '🗄', other: '📦',
};

export const CONN_TYPE_LABELS: Record<ConnectionType, string> = {
  http: 'HTTP', https: 'HTTPS', 'openai-api': 'API OpenAI',
  websocket: 'WebSocket', docker: 'Docker', cuda: 'CUDA',
  hardware: 'Accès matériel', sensor: 'Lecture capteur', pwm: 'Commande PWM',
  database: 'Base de données', network: 'Réseau', custom: 'Personnalisée',
};

export const CONN_STATUS_LABELS: Record<ConnectionStatus, string> = {
  active: 'Active', degraded: 'Dégradée', lost: 'Perdue',
  unknown: 'Inconnue', new: 'Nouvelle', pending: 'En attente de confirmation',
};

export const CONN_ORIGIN_LABELS: Record<ConnectionOrigin, string> = {
  detected: 'Détectée', manual: 'Manuelle', corrected: 'Détectée puis corrigée',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  normal: 'Normal', warning: 'Attention', critical: 'Critique', unknown: 'Inconnu',
};

export const FAN_MODE_LABELS: Record<FanMode, string> = {
  auto: 'Automatique (courbe)', manual: 'Manuel', full: 'Pleine vitesse', test: 'Test temporaire',
};

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  temperature: 'Température', fan: 'Ventilation', service: 'Service',
  connection: 'Connexion', hardware: 'Matériel', profile: 'Profil',
  curve: 'Courbe', alert: 'Alerte', config: 'Configuration',
};
