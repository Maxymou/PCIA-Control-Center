/** DONNÉES SIMULÉES — état initial du système.
 *  Tout ce que l'interface affiche provient d'ici ou du moteur (engine.ts).
 *  Pour brancher un vrai back-end, remplacer la couche `services/dataService.ts`. */

import type {
  Connection, FanConfig, FanId, FanProfile, HardwareItem, Service, ServiceGroup,
} from '../types';

const now = Date.now();

// ---------- Services ----------
export const seedServices: Service[] = [
  { id: 'svc-pcia', name: 'pcia-control-center', displayName: 'PCIA Control Center', type: 'ui', status: 'running', version: '1.0.0', port: 5173, address: '127.0.0.1', process: 'node', origin: 'detected', lastCheck: now, note: 'Interface de supervision (cette application).' },
  { id: 'svc-fand', name: 'pcia-fand', displayName: 'Service ventilateurs', type: 'fan-control', status: 'running', version: '0.9.2', process: 'pcia-fand', origin: 'detected', lastCheck: now, note: 'Daemon de pilotage PWM. Accès i2c/sysfs.' },
  { id: 'svc-docker', name: 'docker', displayName: 'Docker Engine', type: 'docker', status: 'running', version: '27.3.1', process: 'dockerd', origin: 'detected', lastCheck: now },
  { id: 'svc-vllm', name: 'vllm', displayName: 'vLLM', type: 'llm', status: 'running', version: '0.8.4', port: 8000, address: '127.0.0.1', container: 'vllm-server', origin: 'detected', lastCheck: now, note: 'Modèle chargé : Hermes-3-Llama-3.1-70B (2× V100).' },
  { id: 'svc-openwebui', name: 'open-webui', displayName: 'OpenWebUI', type: 'webui', status: 'running', version: '0.6.5', port: 3000, address: '0.0.0.0', container: 'open-webui', origin: 'detected', lastCheck: now },
  { id: 'svc-hermes', name: 'hermes-agent', displayName: 'Hermes', type: 'llm', status: 'stopped', version: '2.1.0', container: 'hermes', origin: 'detected', lastCheck: now, note: 'Arrêté volontairement — libère de la VRAM pour vLLM.' },
  { id: 'svc-api', name: 'pcia-local-api', displayName: 'API locale', type: 'api', status: 'running', version: '0.4.0', port: 8080, address: '127.0.0.1', process: 'node', origin: 'detected', lastCheck: now },
  { id: 'svc-system', name: 'systemd-core', displayName: 'Services système', type: 'system', status: 'running', process: 'systemd', origin: 'detected', lastCheck: now },
  { id: 'svc-proxy', name: 'caddy', displayName: 'Reverse proxy', type: 'proxy', status: 'running', version: '2.9.1', port: 443, address: '0.0.0.0', process: 'caddy', origin: 'detected', lastCheck: now },
  { id: 'svc-postgres', name: 'postgres', displayName: 'PostgreSQL', type: 'database', status: 'running', version: '16.4', port: 5432, address: '127.0.0.1', container: 'postgres', origin: 'detected', lastCheck: now },
  { id: 'svc-node-exp', name: 'node-exporter', displayName: 'Node Exporter', type: 'system', status: 'unreachable', version: '1.8.2', port: 9100, address: '127.0.0.1', origin: 'detected', lastCheck: now - 120_000 },
];

// ---------- Connexions ----------
export const seedConnections: Connection[] = [
  { id: 'cx-1', sourceId: 'svc-pcia', targetId: 'svc-api', type: 'http', protocol: 'HTTP/1.1', port: 8080, endpoint: '/api/v1', status: 'active', origin: 'detected', confidence: 0.98, lastActivity: now },
  { id: 'cx-2', sourceId: 'svc-api', targetId: 'svc-fand', type: 'pwm', status: 'active', origin: 'detected', confidence: 0.9, lastActivity: now, note: 'Consignes PWM transmises via socket Unix.' },
  { id: 'cx-3', sourceId: 'svc-fand', targetId: 'svc-system', type: 'sensor', status: 'active', origin: 'detected', confidence: 0.85, lastActivity: now },
  { id: 'cx-4', sourceId: 'svc-openwebui', targetId: 'svc-vllm', type: 'openai-api', protocol: 'HTTPS', port: 8000, endpoint: '/v1/chat/completions', status: 'active', origin: 'detected', confidence: 0.97, lastActivity: now },
  { id: 'cx-5', sourceId: 'svc-docker', targetId: 'svc-vllm', type: 'docker', status: 'active', origin: 'detected', confidence: 1, lastActivity: now },
  { id: 'cx-6', sourceId: 'svc-docker', targetId: 'svc-openwebui', type: 'docker', status: 'active', origin: 'detected', confidence: 1, lastActivity: now },
  { id: 'cx-7', sourceId: 'svc-docker', targetId: 'svc-hermes', type: 'docker', status: 'unknown', origin: 'detected', confidence: 1, lastActivity: now - 3_600_000 },
  { id: 'cx-8', sourceId: 'svc-vllm', targetId: 'svc-system', type: 'cuda', status: 'active', origin: 'detected', confidence: 0.92, lastActivity: now, note: 'Allocation CUDA sur les deux Tesla V100.' },
  { id: 'cx-9', sourceId: 'svc-proxy', targetId: 'svc-openwebui', type: 'https', protocol: 'HTTPS', port: 3000, status: 'active', origin: 'detected', confidence: 0.95, lastActivity: now },
  { id: 'cx-10', sourceId: 'svc-openwebui', targetId: 'svc-postgres', type: 'database', protocol: 'PostgreSQL', port: 5432, status: 'degraded', origin: 'detected', confidence: 0.88, lastActivity: now - 30_000, note: 'Latences élevées observées depuis 10 min.' },
  { id: 'cx-11', sourceId: 'svc-pcia', targetId: 'svc-node-exp', type: 'http', port: 9100, endpoint: '/metrics', status: 'lost', origin: 'detected', confidence: 0.9, lastActivity: now - 120_000 },
  { id: 'cx-12', sourceId: 'svc-hermes', targetId: 'svc-vllm', type: 'openai-api', port: 8000, status: 'unknown', origin: 'corrected', confidence: 0.6, lastActivity: now - 3_600_000, note: 'Sens corrigé manuellement (la détection initiale était inversée).', detectedOriginal: { sourceId: 'svc-vllm', targetId: 'svc-hermes', type: 'openai-api', port: 8000 } },
];

// ---------- Groupes ----------
export const seedGroups: ServiceGroup[] = [
  { id: 'grp-ia', name: 'Intelligence artificielle', serviceIds: ['svc-vllm', 'svc-hermes'], color: '#7c6df2', note: 'Charges GPU principales.' },
  { id: 'grp-web', name: 'Interfaces web', serviceIds: ['svc-openwebui', 'svc-pcia'], color: '#3b82f6' },
  { id: 'grp-sys', name: 'Système', serviceIds: ['svc-system', 'svc-node-exp'], color: '#6b7280' },
];

/** Suggestions de regroupement (jamais imposées). */
export const groupSuggestions = [
  { name: 'Docker', serviceIds: ['svc-docker', 'svc-vllm', 'svc-openwebui', 'svc-hermes', 'svc-postgres'] },
  { name: 'Réseau', serviceIds: ['svc-proxy', 'svc-api'] },
];

// ---------- Matériel ----------
export function buildHardware(gtxInstalled: boolean): HardwareItem[] {
  return [
    { id: 'cpu', name: 'CPU', kind: 'cpu', model: 'AMD EPYC 7302 (16c/32t)', installed: true, metrics: { temp: 52, load: 34, freq: 3100, power: 118, status: 'normal' } },
    { id: 'nvme', name: 'SSD NVMe', kind: 'storage', model: 'Samsung 990 Pro 2 To', installed: true, metrics: { temp: 44, capacity: 2000, used: 1240, health: 97, activity: 12, status: 'normal' } },
    { id: 'v100-1', name: 'Tesla V100 n°1', kind: 'gpu', model: 'NVIDIA Tesla V100 32 Go', installed: true, pcieSlot: 'PCIe 1', metrics: { temp: 63, load: 72, memUsed: 26.4, memTotal: 32, power: 210, status: 'normal' } },
    { id: 'v100-2', name: 'Tesla V100 n°2', kind: 'gpu', model: 'NVIDIA Tesla V100 32 Go', installed: true, pcieSlot: 'PCIe 2', metrics: { temp: 66, load: 78, memUsed: 27.1, memTotal: 32, power: 224, status: 'normal' } },
    { id: 'gtx1080', name: 'GTX 1080', kind: 'gpu', model: 'NVIDIA GeForce GTX 1080 8 Go', installed: gtxInstalled, pcieSlot: 'PCIe 3', metrics: { temp: 41, load: 8, memUsed: 0.9, memTotal: 8, power: 22, status: 'normal' } },
    { id: 'case-front', name: 'Boîtier avant', kind: 'case', installed: true, metrics: { temp: 31, status: 'normal' } },
    { id: 'case-rear', name: 'Boîtier arrière', kind: 'case', installed: true, metrics: { temp: 34, status: 'normal' } },
    { id: 'motherboard', name: 'Carte mère', kind: 'board', model: 'Supermicro X11 (simulée)', installed: true, metrics: { temp: 38, status: 'normal' } },
  ];
}

/** Seuils de température par matériel : [attention, critique]. */
export const TEMP_THRESHOLDS: Partial<Record<string, [number, number]>> = {
  cpu: [75, 88], nvme: [60, 72], 'v100-1': [80, 88], 'v100-2': [80, 88],
  gtx1080: [78, 88], 'case-front': [45, 55], 'case-rear': [48, 58], motherboard: [55, 65],
};

// ---------- Ventilation ----------
const curveSilent = [{ temp: 30, pwm: 12 }, { temp: 55, pwm: 25 }, { temp: 75, pwm: 55 }, { temp: 90, pwm: 100 }];
const curveBalanced = [{ temp: 30, pwm: 20 }, { temp: 50, pwm: 35 }, { temp: 70, pwm: 65 }, { temp: 85, pwm: 100 }];
const curvePerf = [{ temp: 25, pwm: 35 }, { temp: 50, pwm: 55 }, { temp: 65, pwm: 80 }, { temp: 80, pwm: 100 }];
const curveMax = [{ temp: 20, pwm: 70 }, { temp: 60, pwm: 100 }];

const FAN_IDS: FanId[] = ['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'];
const mkCurves = (c: { temp: number; pwm: number }[]) =>
  Object.fromEntries(FAN_IDS.map((f) => [f, c.map((p) => ({ ...p }))])) as Record<FanId, { temp: number; pwm: number }[]>;

export const seedProfiles: FanProfile[] = [
  { id: 'p-silent', name: 'Silencieux', builtin: true, curves: mkCurves(curveSilent) },
  { id: 'p-balanced', name: 'Équilibré', builtin: true, curves: mkCurves(curveBalanced) },
  { id: 'p-perf', name: 'Performance', builtin: true, curves: mkCurves(curvePerf) },
  { id: 'p-max', name: 'Refroidissement maximal', builtin: true, curves: mkCurves(curveMax) },
];

export const seedFanConfigs: FanConfig[] = [
  { id: 'CPU_FAN1', displayName: 'Ventirad CPU', assignedHardware: 'cpu', sensor: { kind: 'single', source: 'cpu' }, mode: 'auto', manualPwm: 40, minPwm: 10, warnRpm: 300, curve: curveBalanced.map((p) => ({ ...p })) },
  { id: 'SYS_FAN1', displayName: 'Façade avant', assignedHardware: 'case-front', sensor: { kind: 'hottest-gpu' }, mode: 'auto', manualPwm: 40, minPwm: 10, warnRpm: 250, curve: curveBalanced.map((p) => ({ ...p })) },
  { id: 'SYS_FAN2', displayName: 'Extraction arrière', assignedHardware: 'case-rear', sensor: { kind: 'single', source: 'cpu' }, mode: 'auto', manualPwm: 40, minPwm: 10, warnRpm: 250, curve: curveBalanced.map((p) => ({ ...p })) },
  { id: 'SYS_FAN3', displayName: 'Flux V100 n°1', assignedHardware: 'v100-1', sensor: { kind: 'single', source: 'v100-1' }, mode: 'auto', manualPwm: 50, minPwm: 15, warnRpm: 400, curve: curvePerf.map((p) => ({ ...p })) },
  { id: 'SYS_FAN4', displayName: 'Flux V100 n°2', assignedHardware: 'v100-2', sensor: { kind: 'single', source: 'v100-2' }, mode: 'auto', manualPwm: 50, minPwm: 15, warnRpm: 400, curve: curvePerf.map((p) => ({ ...p })) },
];

export const FAN_MAX_RPM: Record<FanId, number> = {
  CPU_FAN1: 2200, SYS_FAN1: 1500, SYS_FAN2: 1500, SYS_FAN3: 2800, SYS_FAN4: 2800,
};
