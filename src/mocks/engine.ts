/** MOTEUR DE SIMULATION.
 *  Fait vivre les données : températures, charges, RPM, états de services,
 *  alertes, événements, historique glissant d'une heure.
 *  Expose aussi les déclencheurs du panneau de démonstration.
 *  Ce fichier (avec seed.ts) est la seule source de « fausses » données. */

import type {
  Alert, AppEvent, Connection, ConnectionConflict, FanConfig, FanId, FanLive,
  HardwareId, HardwareItem, HistoryMarker, HistoryPoint, Service, Severity, Snapshot,
} from '../types';
import {
  buildHardware, FAN_MAX_RPM, seedConnections, seedFanConfigs, seedServices, TEMP_THRESHOLDS,
} from './seed';
import { evalCurve } from '../utils/curve';
import { uid } from '../utils/format';

const TICK_MS = 2000;
const HISTORY_STEP_MS = 10_000;   // un point toutes les 10 s
const HISTORY_SPAN_MS = 60 * 60 * 1000;

type Listener = (s: Snapshot) => void;

// ---------- État interne ----------
let gtxInstalled = true;
let backendConnected = true;
let services: Service[] = structuredClone(seedServices);
let connections: Connection[] = structuredClone(seedConnections);
let conflicts: ConnectionConflict[] = [];
let hardware: HardwareItem[] = buildHardware(gtxInstalled);
let fanConfigs: FanConfig[] = structuredClone(seedFanConfigs);
let fanLive: Record<FanId, FanLive> = Object.fromEntries(
  fanConfigs.map((f) => [f.id, { id: f.id, pwm: 30, rpm: 900, refTemp: 50, status: 'normal' as Severity }]),
) as Record<FanId, FanLive>;
let alerts: Alert[] = [];
let events: AppEvent[] = [];
let history: HistoryPoint[] = [];
let markers: HistoryMarker[] = [];
let listeners: Listener[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let lastHistoryAt = 0;

// Cibles de dérive et forçages démo
const tempTargets: Partial<Record<HardwareId, number>> = {};
const stalledFans = new Set<FanId>();
const stallSince: Partial<Record<FanId, number>> = {};

function rnd(a: number, b: number) { return a + Math.random() * (b - a); }
function drift(v: number, target: number, speed: number, noise: number) {
  return v + (target - v) * speed + rnd(-noise, noise);
}

// ---------- Événements & alertes ----------
export function pushEvent(e: Omit<AppEvent, 'id' | 'time'> & { time?: number }) {
  events = [{ id: uid('ev'), time: e.time ?? Date.now(), ...e }, ...events].slice(0, 200);
}

function addMarker(label: string, kind: HistoryMarker['kind']) {
  markers = [...markers, { t: Date.now(), label, kind }].filter((m) => m.t > Date.now() - HISTORY_SPAN_MS);
}

function raiseAlert(a: Omit<Alert, 'id' | 'time' | 'acknowledged' | 'active'>): Alert {
  const existing = alerts.find(
    (x) => x.active && x.targetKind === a.targetKind && x.targetId === a.targetId && x.message === a.message,
  );
  if (existing) return existing;
  const alert: Alert = { id: uid('al'), time: Date.now(), acknowledged: false, active: true, ...a };
  alerts = [alert, ...alerts].slice(0, 100);
  pushEvent({ category: 'alert', level: a.level === 'critical' ? 'critical' : 'warning', targetLabel: a.targetLabel, message: a.message });
  addMarker(a.targetLabel, 'alert');
  return alert;
}

function resolveAlerts(targetKind: Alert['targetKind'], targetId: string, keep?: (a: Alert) => boolean) {
  alerts = alerts.map((a) =>
    a.targetKind === targetKind && a.targetId === targetId && a.active && !(keep && keep(a))
      ? { ...a, active: false } : a,
  );
}

// ---------- Capteurs ----------
function tempOf(id: HardwareId): number {
  return hardware.find((h) => h.id === id && h.installed)?.metrics.temp ?? 0;
}

function refTempFor(cfg: FanConfig): number {
  const s = cfg.sensor;
  const gpus: HardwareId[] = (['v100-1', 'v100-2', 'gtx1080'] as HardwareId[]).filter(
    (g) => hardware.find((h) => h.id === g)?.installed,
  );
  switch (s.kind) {
    case 'single': return tempOf(s.source);
    case 'hottest-gpu': return Math.max(0, ...gpus.map(tempOf));
    case 'max': return Math.max(0, ...s.sources.map(tempOf));
    case 'avg': {
      const vals = s.sources.map(tempOf).filter((v) => v > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
  }
}

// ---------- Tick principal ----------
function severityForTemp(id: string, temp: number): Severity {
  const th = TEMP_THRESHOLDS[id];
  if (!th) return 'normal';
  if (temp >= th[1]) return 'critical';
  if (temp >= th[0]) return 'warning';
  return 'normal';
}

function tick() {
  const t = Date.now();

  // Matériel : dérive douce vers les cibles
  hardware = hardware.map((h) => {
    if (!h.installed) return h;
    const m = { ...h.metrics };
    const baseTemp: Record<string, number> = {
      cpu: 52, nvme: 44, 'v100-1': 63, 'v100-2': 66, gtx1080: 41,
      'case-front': 31, 'case-rear': 34, motherboard: 38,
    };
    const target = tempTargets[h.id] ?? baseTemp[h.id] ?? 40;
    if (m.temp !== undefined) m.temp = Math.round(drift(m.temp, target, 0.06, 0.5) * 10) / 10;
    if (m.load !== undefined) m.load = Math.max(0, Math.min(100, Math.round(drift(m.load, h.kind === 'gpu' ? 75 : 34, 0.05, 3))));
    if (m.power !== undefined) m.power = Math.max(5, Math.round(drift(m.power, h.kind === 'gpu' ? 215 : 118, 0.05, 5)));
    if (m.activity !== undefined) m.activity = Math.max(0, Math.min(100, Math.round(drift(m.activity, 12, 0.1, 4))));
    if (m.freq !== undefined) m.freq = Math.round(drift(m.freq, 3100, 0.05, 40));
    if (m.memUsed !== undefined && m.memTotal !== undefined) {
      m.memUsed = Math.max(0.5, Math.min(m.memTotal, Math.round(drift(m.memUsed, m.memTotal * 0.83, 0.03, 0.2) * 10) / 10));
    }
    const sev = m.temp !== undefined ? severityForTemp(h.id, m.temp) : 'normal';
    m.status = sev;

    // Alertes température
    if (m.temp !== undefined) {
      const th = TEMP_THRESHOLDS[h.id];
      if (th && sev !== 'normal') {
        raiseAlert({
          level: sev === 'critical' ? 'critical' : 'warning',
          targetKind: 'hardware', targetId: h.id, targetLabel: h.name,
          message: sev === 'critical' ? 'Température critique' : 'Température élevée',
          value: `${m.temp.toFixed(1)} °C`, threshold: `${sev === 'critical' ? th[1] : th[0]} °C`,
          recommendation: 'Vérifier la ventilation associée et la charge du composant.',
        });
      } else {
        // Ne résout automatiquement que les alertes de température
        resolveAlerts('hardware', h.id, (a) => !a.message.startsWith('Température'));
      }
    }
    return { ...h, metrics: m };
  });

  // Ventilateurs
  for (const cfg of fanConfigs) {
    const live = { ...fanLive[cfg.id] };
    live.refTemp = Math.round(refTempFor(cfg) * 10) / 10;

    // Décompte du mode test
    if (cfg.mode === 'test' && live.testRemaining !== undefined) {
      live.testRemaining = Math.max(0, live.testRemaining - TICK_MS / 1000);
    }

    let pwm: number;
    switch (cfg.mode) {
      case 'manual': pwm = cfg.manualPwm; break;
      case 'full': pwm = 100; break;
      case 'test': pwm = (live.testRemaining ?? 0) > 0 ? 100 : evalCurve(cfg.curve, live.refTemp); break;
      default: pwm = evalCurve(cfg.curve, live.refTemp);
    }
    if (pwm > 0) pwm = Math.max(cfg.minPwm, pwm);
    live.pwm = Math.round(pwm);

    // RPM simulé
    if (stalledFans.has(cfg.id)) {
      live.rpm = 0;
      live.stalled = true;
      if (!stallSince[cfg.id]) stallSince[cfg.id] = t;
      // Logique demandée : consigne > 30 % et RPM = 0 depuis plus de 10 s
      if (live.pwm > 30 && t - (stallSince[cfg.id] ?? t) > 10_000) {
        live.status = 'critical';
        raiseAlert({
          level: 'critical', targetKind: 'fan', targetId: cfg.id, targetLabel: cfg.displayName,
          message: 'Ventilateur arrêté malgré une consigne active',
          value: '0 RPM', threshold: `Consigne ${live.pwm} %`,
          recommendation: 'Vérifier le branchement et la rotation du ventilateur.',
        });
      } else {
        live.status = 'warning';
      }
    } else {
      delete stallSince[cfg.id];
      live.stalled = false;
      const target = FAN_MAX_RPM[cfg.id] * (live.pwm / 100);
      live.rpm = Math.max(0, Math.round(drift(live.rpm, target, 0.4, 12)));
      if (live.pwm === 0) live.rpm = 0;
      live.status = live.rpm > 0 && live.rpm < cfg.warnRpm && live.pwm > 20 ? 'warning' : 'normal';
      resolveAlerts('fan', cfg.id);
    }
    fanLive[cfg.id] = live;
  }

  // Services : « dernier contrôle » et transitions de démarrage
  services = services.map((s) => {
    if (s.status === 'starting' || s.status === 'restarting') {
      if (Math.random() < 0.3) {
        pushEvent({ category: 'service', level: 'normal', targetLabel: s.displayName ?? s.name, message: 'Service démarré' });
        resolveAlerts('service', s.id);
        return { ...s, status: 'running', lastCheck: t };
      }
      return { ...s, lastCheck: t };
    }
    if (s.status === 'running') return { ...s, lastCheck: t };
    return s;
  });

  // Historique
  if (t - lastHistoryAt >= HISTORY_STEP_MS) {
    lastHistoryAt = t;
    const point: HistoryPoint = { t, temps: {}, rpm: {}, pwm: {} };
    for (const h of hardware) {
      if (h.installed && h.metrics.temp !== undefined && h.id !== 'case-front' && h.id !== 'case-rear') {
        point.temps[h.id] = h.metrics.temp;
      }
    }
    for (const f of fanConfigs) {
      point.rpm[f.id] = fanLive[f.id].rpm;
      point.pwm[f.id] = fanLive[f.id].pwm;
    }
    history = [...history, point].filter((p) => p.t > t - HISTORY_SPAN_MS);
    markers = markers.filter((m) => m.t > t - HISTORY_SPAN_MS);
  }

  emit();
}

// ---------- Historique initial (60 dernières minutes) ----------
function seedHistory() {
  const t0 = Date.now() - HISTORY_SPAN_MS;
  const temps: Partial<Record<HardwareId, number>> = { cpu: 50, nvme: 43, 'v100-1': 61, 'v100-2': 64, gtx1080: 40, motherboard: 38 };
  history = [];
  for (let i = 0; i < 60; i++) {
    const t = t0 + i * 60_000;
    const point: HistoryPoint = { t, temps: {}, rpm: {}, pwm: {} };
    for (const [id, v] of Object.entries(temps) as [HardwareId, number][]) {
      if (id === 'gtx1080' && !gtxInstalled) continue;
      temps[id] = v + rnd(-0.8, 0.9);
      point.temps[id] = Math.round((temps[id] as number) * 10) / 10;
    }
    for (const cfg of fanConfigs) {
      const ref = point.temps['cpu'] ?? 50;
      const pwm = Math.round(evalCurve(cfg.curve, ref) + rnd(-2, 2));
      point.pwm[cfg.id] = Math.max(0, Math.min(100, pwm));
      point.rpm[cfg.id] = Math.round(FAN_MAX_RPM[cfg.id] * (point.pwm[cfg.id]! / 100) + rnd(-30, 30));
    }
    history.push(point);
  }
  lastHistoryAt = Date.now();
}

// ---------- Snapshot & abonnement ----------
function snapshot(): Snapshot {
  return {
    time: Date.now(),
    backendConnected,
    services, connections, conflicts, hardware,
    fans: fanConfigs.map((f) => fanLive[f.id]),
    alerts, events, history, markers,
  };
}

function emit() { const s = snapshot(); listeners.forEach((l) => l(s)); }

export const engine = {
  start() {
    if (timer) return;
    seedHistory();
    // Alertes initiales cohérentes avec les données de départ
    raiseAlert({
      level: 'warning', targetKind: 'connection', targetId: 'cx-10', targetLabel: 'OpenWebUI → PostgreSQL',
      message: 'Connexion dégradée (latences élevées)', value: '~480 ms', threshold: '150 ms',
      recommendation: 'Vérifier la charge de PostgreSQL.',
    });
    raiseAlert({
      level: 'critical', targetKind: 'service', targetId: 'svc-node-exp', targetLabel: 'Node Exporter',
      message: 'Service inaccessible', recommendation: 'Redémarrer le service ou vérifier le port 9100.',
    });
    timer = setInterval(tick, TICK_MS);
    tick();
  },
  subscribe(l: Listener): () => void {
    listeners.push(l);
    l(snapshot());
    return () => { listeners = listeners.filter((x) => x !== l); };
  },
  getSnapshot: snapshot,

  /** Le store de configuration pousse les réglages ventilateurs ici. */
  setFanConfigs(cfgs: FanConfig[]) { fanConfigs = cfgs; },
  startFanTest(id: FanId, seconds: number) {
    fanLive[id] = { ...fanLive[id], testRemaining: seconds };
  },
  stopFanTest(id: FanId) {
    fanLive[id] = { ...fanLive[id], testRemaining: 0 };
  },

  ackAlert(id: string) { alerts = alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)); pushEvent({ category: 'alert', level: 'normal', targetLabel: alerts.find(a => a.id === id)?.targetLabel ?? '', message: 'Alerte acquittée' }); emit(); },
  snoozeAlert(id: string, minutes: number) { alerts = alerts.map((a) => (a.id === id ? { ...a, snoozedUntil: Date.now() + minutes * 60_000 } : a)); emit(); },
  unsnoozeAlert(id: string) { alerts = alerts.map((a) => (a.id === id ? { ...a, snoozedUntil: undefined } : a)); emit(); },

  resolveConflict(connectionId: string, accept: boolean) {
    const c = conflicts.find((x) => x.connectionId === connectionId);
    conflicts = conflicts.filter((x) => x.connectionId !== connectionId);
    if (c && accept) {
      connections = connections.map((cx) =>
        cx.id === connectionId ? { ...cx, ...c.detected, origin: 'detected', detectedOriginal: undefined } : cx,
      );
      pushEvent({ category: 'connection', level: 'normal', targetLabel: connectionId, message: 'Nouvelle détection acceptée' });
    } else {
      pushEvent({ category: 'connection', level: 'normal', targetLabel: connectionId, message: 'Correction utilisateur conservée' });
    }
    emit();
  },

  // ---------- Déclencheurs du panneau de démonstration ----------
  demo: {
    heatUpV100() {
      tempTargets['v100-2'] = 91;
      pushEvent({ category: 'temperature', level: 'warning', targetLabel: 'Tesla V100 n°2', message: 'Montée en température simulée' });
    },
    blockFan() {
      stalledFans.add('SYS_FAN4');
      pushEvent({ category: 'fan', level: 'warning', targetLabel: 'SYS_FAN4', message: 'Blocage ventilateur simulé' });
    },
    stopService() {
      services = services.map((s) => (s.id === 'svc-openwebui' ? { ...s, status: 'crashed' } : s));
      raiseAlert({
        level: 'critical', targetKind: 'service', targetId: 'svc-openwebui', targetLabel: 'OpenWebUI',
        message: 'Arrêt inattendu du service', recommendation: 'Consulter les journaux du conteneur.',
      });
      pushEvent({ category: 'service', level: 'critical', targetLabel: 'OpenWebUI', message: 'Service arrêté de façon inattendue' });
      emit();
    },
    loseConnection() {
      connections = connections.map((c) => (c.id === 'cx-4' ? { ...c, status: 'lost' } : c));
      raiseAlert({
        level: 'warning', targetKind: 'connection', targetId: 'cx-4', targetLabel: 'OpenWebUI → vLLM',
        message: 'Connexion perdue', recommendation: 'Vérifier que vLLM répond sur le port 8000.',
      });
      pushEvent({ category: 'connection', level: 'warning', targetLabel: 'OpenWebUI → vLLM', message: 'Connexion perdue' });
      emit();
    },
    detectNewService() {
      if (services.some((s) => s.id === 'svc-grafana')) return;
      services = [...services, {
        id: 'svc-grafana', name: 'grafana', displayName: 'Grafana', type: 'webui',
        status: 'running', version: '11.5.0', port: 3001, address: '127.0.0.1',
        container: 'grafana', origin: 'detected', lastCheck: Date.now(), isNew: true,
      }];
      connections = [...connections, {
        id: 'cx-grafana', sourceId: 'svc-grafana', targetId: 'svc-postgres', type: 'database',
        port: 5432, status: 'new', origin: 'detected', confidence: 0.8, lastActivity: Date.now(),
      }];
      pushEvent({ category: 'service', level: 'normal', targetLabel: 'Grafana', message: 'Nouveau service détecté' });
      emit();
    },
    conflictingDetection() {
      const target = connections.find((c) => c.origin === 'corrected');
      if (!target || conflicts.some((c) => c.connectionId === target.id)) return;
      conflicts = [...conflicts, {
        connectionId: target.id, createdAt: Date.now(),
        detected: { sourceId: target.detectedOriginal?.sourceId ?? target.targetId, targetId: target.detectedOriginal?.targetId ?? target.sourceId, type: target.type, port: target.port, endpoint: target.endpoint },
      }];
      pushEvent({ category: 'connection', level: 'warning', targetLabel: 'Hermes ↔ vLLM', message: 'Nouvelle détection en contradiction avec une correction' });
      emit();
    },
    toggleGtx() {
      gtxInstalled = !gtxInstalled;
      hardware = hardware.map((h) => (h.id === 'gtx1080' ? { ...h, installed: gtxInstalled } : h));
      pushEvent({
        category: 'hardware', level: 'normal', targetLabel: 'GTX 1080',
        message: gtxInstalled ? 'Nouveau matériel détecté (GTX 1080 installée)' : 'Matériel retiré (GTX 1080 absente)',
      });
      emit();
    },
    newAlert() {
      raiseAlert({
        level: 'warning', targetKind: 'hardware', targetId: 'nvme', targetLabel: 'SSD NVMe',
        message: 'Activité disque inhabituelle', value: '92 %', threshold: '80 %',
        recommendation: 'Identifier le processus responsable des écritures.',
      });
      emit();
    },
    backToNormal() {
      delete tempTargets['v100-2'];
      stalledFans.clear();
      services = services.map((s) =>
        s.id === 'svc-openwebui' && s.status === 'crashed' ? { ...s, status: 'restarting' } : s,
      );
      connections = connections.map((c) => (c.id === 'cx-4' ? { ...c, status: 'active', lastActivity: Date.now() } : c));
      resolveAlerts('connection', 'cx-4');
      pushEvent({ category: 'config', level: 'normal', targetLabel: 'Système', message: 'Retour à l’état normal simulé' });
      emit();
    },
    toggleBackend() {
      backendConnected = !backendConnected;
      emit();
    },
  },
  isGtxInstalled: () => gtxInstalled,
  logEvent(e: Omit<AppEvent, 'id' | 'time'>) { pushEvent(e); emit(); },
  addProfileMarker(label: string) { addMarker(label, 'profile'); },
};
