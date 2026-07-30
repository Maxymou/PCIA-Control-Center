/** Tests d'intégration de l'API : routes REST, WebSocket, mode démonstration.
 *
 *  Le serveur est démarré pour de vrai (sur un port éphémère), avec une base
 *  SQLite temporaire et le backend hwmon simulé.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { ServerSnapshot, WsMessage } from '../src/contract.js';
import { AppState } from '../src/app/state.js';
import { FanGateway } from '../src/app/fanGateway.js';
import { FanHost } from '../src/fan/host.js';
import { buildHttpServer } from '../src/http/server.js';
import { WsHub } from '../src/http/ws.js';
import type { ApiContext } from '../src/http/context.js';
import { SimulatedHwmonBackend } from '../src/hwmon/simulated.js';
import { calibrateAll, createTestEnv, sleep, type TestEnv } from './helpers.js';
import type { RuntimeEnv } from '../src/runtime.js';

let env: TestEnv;
let app: FastifyInstance;
let host: FanHost;
let state: AppState;
let baseUrl: string;

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  env = createTestEnv();
  calibrateAll(env);

  const runtimeEnv: RuntimeEnv = {
    config: env.config,
    mode: 'demo',
    degraded: false,
    degradedReasons: [],
    hwmon: env.hwmon as SimulatedHwmonBackend,
    demo: env.world,
  };

  // Boucle rapide : les assertions n'attendent pas une seconde par cycle.
  env.config.fanControl.loopIntervalMs = 200;
  host = new FanHost({
    config: env.config,
    repos: env.repos,
    hwmon: env.hwmon,
    mode: 'demo',
    gpuProvider: () => env.world.gpus(),
    withIpc: false,
    withStateFile: false,
  });
  host.start();

  const fans = new FanGateway(env.config, host);
  const ws = new WsHub(() => state.snapshot());
  state = new AppState({
    env: runtimeEnv,
    repos: env.repos,
    embeddedFanHost: host,
    onSnapshot: (snapshot) => ws.broadcast('snapshot', snapshot),
  });

  const ctx: ApiContext = {
    config: env.config,
    env: runtimeEnv,
    repos: env.repos,
    state,
    fans,
    ws,
    publish: (type) => {
      const snapshot = state.refresh();
      if (type) ws.broadcast(type, { time: snapshot.time });
    },
    emit: (type, payload) => ws.broadcast(type, payload),
  };

  await state.start();
  ws.start();
  app = await buildHttpServer(ctx);
  // Port 0 : le système choisit un port libre, aucun conflit avec l'hôte.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

afterAll(async () => {
  state.stop();
  await app.close();
  await host.stop();
  env.cleanup();
});

describe('santé et état système', () => {
  it('répond sur /api/health', async () => {
    const { status, body } = await get<{ status: string; mode: string }>('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('demo');
  });

  it('annonce explicitement le mode démonstration', async () => {
    const { body } = await get<ServerSnapshot['system']>('/api/system/status');
    expect(body.mode).toBe('demo');
    expect(body.capabilities.canWritePwm).toBe(true);
  });

  it('produit un rapport de diagnostic sans secret', async () => {
    const { status, body } = await get<Record<string, any>>('/api/diagnostics');
    expect(status).toBe(200);
    expect(body.hwmon.controllers.length).toBeGreaterThan(0);
    expect(body.configuration.security.tokenConfigured).toBe(false);
    // Aucun jeton ni numéro de série ne doit apparaître dans le rapport.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"token"\s*:\s*"/);
    expect(serialized).not.toMatch(/serial/i);
  });
});

describe('snapshot', () => {
  it('contient tous les champs attendus par le front-end', async () => {
    const { body } = await get<ServerSnapshot>('/api/snapshot');
    for (const key of ['time', 'backendConnected', 'services', 'connections', 'conflicts',
      'hardware', 'fans', 'alerts', 'events', 'history', 'markers']) {
      expect(body).toHaveProperty(key);
    }
    // Champs additionnels du back-end, ignorés par les composants existants.
    expect(body.system).toBeDefined();
    expect(body.fanOutputs).toHaveLength(5);
  });

  it('expose les cinq sorties logiques attendues', async () => {
    const { body } = await get<ServerSnapshot>('/api/snapshot');
    expect(body.fans.map((f) => f.id)).toEqual(['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4']);
  });

  it('n’expose la GTX 1080 que si elle est détectée', async () => {
    const before = await get<ServerSnapshot>('/api/snapshot');
    expect(before.body.hardware.find((h) => h.id === 'gtx1080')!.installed).toBe(true);

    await send('POST', '/api/demo/toggleGtx');
    await sleep(200);
    const after = await get<ServerSnapshot>('/api/snapshot');
    expect(after.body.hardware.find((h) => h.id === 'gtx1080')!.installed).toBe(false);

    await send('POST', '/api/demo/toggleGtx');
    await sleep(200);
  });

  it('identifie les GPU par UUID stable', async () => {
    const { body } = await get<{ gpus: { uuid: string }[]; slots: Record<string, { uuid: string }> }>('/api/hardware/gpus');
    expect(body.gpus.every((g) => g.uuid.startsWith('GPU-'))).toBe(true);
    expect(body.slots['v100-1'].uuid).not.toBe(body.slots['v100-2'].uuid);
  });
});

describe('ventilation', () => {
  it('refuse une courbe décroissante et conserve la précédente', async () => {
    const before = await get<{ config: { curve: unknown[] } }>('/api/fans/CPU_FAN1');
    const refused = await send<{ error: string; details: string[] }>(
      'PUT', '/api/fans/CPU_FAN1/curve',
      { curve: [{ temp: 40, pwm: 90 }, { temp: 60, pwm: 50 }] },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('INVALID_CURVE');

    const after = await get<{ config: { curve: unknown[] } }>('/api/fans/CPU_FAN1');
    expect(after.body.config.curve).toEqual(before.body.config.curve);
  });

  it('refuse une courbe d’un seul point', async () => {
    const res = await send<{ error: string }>('PUT', '/api/fans/CPU_FAN1/curve', { curve: [{ temp: 40, pwm: 50 }] });
    expect(res.status).toBe(400);
  });

  it('accepte et applique immédiatement une courbe valide', async () => {
    const curve = [{ temp: 35, pwm: 25 }, { temp: 55, pwm: 45 }, { temp: 75, pwm: 100 }];
    const res = await send<{ ok: boolean }>('PUT', '/api/fans/CPU_FAN1/curve', { curve });
    expect(res.status).toBe(200);

    const after = await get<{ config: { curve: typeof curve } }>('/api/fans/CPU_FAN1');
    expect(after.body.config.curve).toEqual(curve);
  });

  it('impose le plancher de sécurité aux sorties des cartes passives', async () => {
    await send('PUT', '/api/fans/SYS_FAN3/configuration', { minPwm: 0 });
    const { body } = await get<{ config: { minPwm: number } }>('/api/fans/SYS_FAN3');
    expect(body.config.minPwm).toBeGreaterThanOrEqual(env.config.fanControl.passiveGpuFloorPwm);
  });

  it('refuse une sortie inconnue', async () => {
    const res = await send<{ error: string }>('PUT', '/api/fans/SYS_FAN9/mode', { mode: 'manual' });
    expect(res.status).toBe(404);
  });

  it('refuse un mode invalide', async () => {
    const res = await send<{ error: string }>('PUT', '/api/fans/CPU_FAN1/mode', { mode: 'turbo' });
    expect(res.status).toBe(400);
  });

  it('lance et arrête un test temporaire', async () => {
    const started = await send<{ ok: boolean }>('POST', '/api/fans/CPU_FAN1/test', { seconds: 5 });
    expect(started.status).toBe(200);
    // La consigne est appliquée par le cycle suivant du moteur.
    await sleep(600);
    const during = await get<{ output: { pwm: number } }>('/api/fans/CPU_FAN1');
    expect(during.body.output.pwm).toBe(100);

    await send('POST', '/api/fans/CPU_FAN1/stop-test');
  });

  it('restitue une sortie au BIOS puis la reprend', async () => {
    const returned = await send<{ ok: boolean }>('POST', '/api/fans/SYS_FAN2/return-to-bios');
    expect(returned.status).toBe(200);
    let fan = await get<{ output: { controlState: string } }>('/api/fans/SYS_FAN2');
    expect(fan.body.output.controlState).toBe('BIOS_CONTROLLED');

    const retaken = await send<{ ok: boolean }>('POST', '/api/fans/SYS_FAN2/take-software-control');
    expect(retaken.status).toBe(200);
    fan = await get<{ output: { controlState: string } }>('/api/fans/SYS_FAN2');
    expect(fan.body.output.controlState).toBe('SOFTWARE_CONTROLLED');
  });
});

describe('profils', () => {
  it('applique un profil prédéfini à toutes les sorties', async () => {
    const res = await send<{ ok: boolean; applied: string[] }>('POST', '/api/fan-profiles/p-silent/apply');
    expect(res.status).toBe(200);
    expect(res.body.applied).toHaveLength(5);

    const { body } = await get<{ activeProfileId: string }>('/api/fan-profiles');
    expect(body.activeProfileId).toBe('p-silent');
  });

  it('crée une copie personnalisée plutôt que de modifier un profil prédéfini', async () => {
    const res = await send<{ id: string; builtin: boolean; derivedFrom: string }>(
      'PUT', '/api/fan-profiles/p-silent', { name: 'Silencieux modifié' },
    );
    expect(res.status).toBe(201);
    expect(res.body.builtin).toBe(false);
    expect(res.body.derivedFrom).toBe('p-silent');

    // Le profil prédéfini est intact.
    const profiles = await get<{ profiles: { id: string; name: string }[] }>('/api/fan-profiles');
    expect(profiles.body.profiles.find((p) => p.id === 'p-silent')!.name).toBe('Silencieux');
  });

  it('refuse la suppression d’un profil prédéfini', async () => {
    const res = await send<{ error: string }>('DELETE', '/api/fan-profiles/p-balanced');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BUILTIN_PROFILE');
  });

  it('duplique puis supprime un profil personnalisé', async () => {
    const copy = await send<{ id: string }>('POST', '/api/fan-profiles/p-perf/duplicate');
    expect(copy.status).toBe(201);
    const removed = await send<{ ok: boolean }>('DELETE', `/api/fan-profiles/${copy.body.id}`);
    expect(removed.status).toBe(200);
  });

  it('garantit un plancher non nul sur les sorties passives dans tous les profils', async () => {
    const { body } = await get<{ profiles: { builtin: boolean; curves: Record<string, { pwm: number }[]> }[] }>('/api/fan-profiles');
    for (const profile of body.profiles.filter((p) => p.builtin)) {
      for (const fanId of ['SYS_FAN3', 'SYS_FAN4']) {
        expect(Math.min(...profile.curves[fanId].map((p) => p.pwm))).toBeGreaterThan(0);
      }
    }
  });
});

describe('services et connexions', () => {
  it('ajoute puis masque un service manuel', async () => {
    const created = await send<{ id: string }>('POST', '/api/services/manual', {
      name: 'service-test', type: 'api', status: 'running', port: 12345, note: 'Ajouté par test',
    });
    expect(created.status).toBe(201);

    const listed = await get<{ services: { id: string }[] }>('/api/services');
    expect(listed.body.services.some((s) => s.id === created.body.id)).toBe(true);

    await send('POST', `/api/services/${created.body.id}/hide`);
    const hidden = await get<{ services: { id: string }[] }>('/api/services');
    expect(hidden.body.services.some((s) => s.id === created.body.id)).toBe(false);

    await send('DELETE', `/api/services/${created.body.id}`);
  });

  it('refuse de supprimer un service détecté', async () => {
    const { body } = await get<ServerSnapshot>('/api/snapshot');
    const detected = body.services.find((s) => s.origin === 'detected')!;
    const res = await send<{ error: string }>('DELETE', `/api/services/${detected.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_DELETABLE');
  });

  it('expose méthode et niveau de confiance sur les connexions', async () => {
    const { body } = await get<{ connections: Record<string, unknown>[] }>('/api/connections');
    expect(body.connections.length).toBeGreaterThan(0);
    for (const connection of body.connections) {
      expect(connection.detectionMethod).toBeDefined();
      expect(connection.confidenceLevel).toBeDefined();
      expect(typeof connection.confidence).toBe('number');
    }
  });

  it('corrige une connexion et conserve la détection d’origine', async () => {
    const list = await get<{ connections: { id: string; sourceId: string; targetId: string }[] }>('/api/connections');
    const target = list.body.connections[0];

    const res = await send<{ ok: boolean }>('PUT', `/api/connections/${target.id}`, {
      sourceId: target.targetId, targetId: target.sourceId, note: 'Sens corrigé',
    });
    expect(res.status).toBe(200);

    const detail = await get<{ connection: Record<string, any> }>(`/api/connections/${target.id}`);
    expect(detail.body.connection.origin).toBe('corrected');
    expect(detail.body.connection.sourceId).toBe(target.targetId);
    expect(detail.body.connection.detectedOriginal.sourceId).toBe(target.sourceId);

    // Restauration de la version détectée.
    const restored = await send<{ ok: boolean }>('POST', `/api/connections/${target.id}/restore-detected`);
    expect(restored.status).toBe(200);
  });

  it('refuse une connexion manuelle vers un service inconnu', async () => {
    const res = await send<{ error: string }>('POST', '/api/connections/manual', {
      sourceId: 'inexistant-1', targetId: 'inexistant-2', type: 'http',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_ENDPOINT');
  });
});

describe('alertes et historique', () => {
  it('acquitte une alerte sans la désactiver', async () => {
    const { alert } = env.repos.alerts.raise({
      type: 'HIGH_TEMPERATURE', level: 'warning', targetKind: 'hardware',
      targetId: 'test-target', targetLabel: 'Cible de test', message: 'Alerte de test',
    });
    const res = await send<{ acknowledged: boolean; active: boolean }>('POST', `/api/alerts/${alert.id}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(res.body.active).toBe(true);
  });

  it('renvoie 404 pour une alerte inconnue', async () => {
    const res = await send<{ error: string }>('POST', '/api/alerts/inexistante/acknowledge');
    expect(res.status).toBe(404);
  });

  it('sert une fenêtre d’historique paramétrable', async () => {
    const { status, body } = await get<{ windowMinutes: number; points: unknown[] }>('/api/history?minutes=60');
    expect(status).toBe(200);
    expect(body.windowMinutes).toBe(60);
    expect(Array.isArray(body.points)).toBe(true);
  });

  it('journalise un événement envoyé par l’interface', async () => {
    const res = await send<{ id: string }>('POST', '/api/events', {
      category: 'curve', level: 'normal', targetLabel: 'Ventirad CPU', message: 'Courbe modifiée',
    });
    expect(res.status).toBe(201);
    const events = await get<{ events: { message: string }[] }>('/api/events?limit=10');
    expect(events.body.events.some((e) => e.message === 'Courbe modifiée')).toBe(true);
  });
});

describe('configuration', () => {
  it('exporte et réimporte la configuration', async () => {
    const exported = await get<Record<string, unknown>>('/api/config/export');
    expect(exported.status).toBe(200);
    expect(exported.body.application).toBe('pcia-control-center');

    const imported = await send<{ ok: boolean }>('POST', '/api/config/import', exported.body);
    expect(imported.status).toBe(200);
  });

  it('refuse un import contenant une courbe invalide', async () => {
    const res = await send<{ error: string }>('POST', '/api/config/import', {
      version: 1,
      fanConfigs: [{ id: 'CPU_FAN1', displayName: 'x', assignedHardware: 'cpu',
        sensor: { kind: 'single', source: 'cpu' }, mode: 'auto', manualPwm: 40,
        minPwm: 10, warnRpm: 300, curve: [{ temp: 60, pwm: 20 }, { temp: 40, pwm: 80 }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IMPORT');
  });

  it('persiste les préférences d’interface', async () => {
    await send('PUT', '/api/config/ui', { data: { layout: { positions: { a: { x: 1, y: 2 } } } } });
    const { body } = await get<{ data: Record<string, any> }>('/api/config/ui');
    expect(body.data.layout.positions.a).toEqual({ x: 1, y: 2 });
  });
});

describe('mode démonstration', () => {
  it('liste les scénarios disponibles', async () => {
    const { body } = await get<{ enabled: boolean; scenarios: string[] }>('/api/demo');
    expect(body.enabled).toBe(true);
    expect(body.scenarios).toContain('blockFan');
  });

  it('refuse un scénario inconnu', async () => {
    const res = await send<{ error: string }>('POST', '/api/demo/scenarioInexistant');
    expect(res.status).toBe(404);
  });

  it('exécute un scénario et le réinitialise', async () => {
    const res = await send<{ ok: boolean; message: string }>('POST', '/api/demo/stopService');
    expect(res.status).toBe(200);
    await sleep(200);

    const snapshot = await get<ServerSnapshot>('/api/snapshot');
    const service = snapshot.body.services.find((s) => s.name === 'open-webui');
    expect(service?.status).toBe('crashed');

    await send('POST', '/api/demo/backToNormal');
  });
});

describe('routes inconnues', () => {
  it('renvoie une erreur structurée sur /api', async () => {
    const { status, body } = await get<{ error: string }>('/api/inexistant');
    expect(status).toBe(404);
    expect(body.error).toBe('NOT_FOUND');
  });
});

describe('WebSocket', () => {
  it('envoie un snapshot complet dès la connexion', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/live`);
    const message = await new Promise<WsMessage<ServerSnapshot>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Aucun message reçu')), 8000);
      socket.on('message', (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()) as WsMessage<ServerSnapshot>);
      });
      socket.on('error', reject);
    });
    socket.close();

    expect(message.type).toBe('snapshot');
    expect(message.schema).toBe(1);
    expect(message.payload.services.length).toBeGreaterThan(0);
    expect(typeof message.timestamp).toBe('number');
  });

  it('diffuse les mises à jour aux clients connectés', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/live`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.on('message', (raw) => received.push((JSON.parse(raw.toString()) as WsMessage).type));

    await sleep(200);
    await send('POST', '/api/fans/CPU_FAN1/stop-test');
    await sleep(600);
    socket.close();

    expect(received.length).toBeGreaterThan(0);
  });
});
