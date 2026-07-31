/** `pcia-control-center` — serveur d'application.
 *
 *  Sert le front-end compilé, l'API REST et le WebSocket sur le même port
 *  (4321 par défaut, écoute sur 0.0.0.0 pour être joignable depuis le réseau
 *  local). Héberge la supervision, la base SQLite et les alertes.
 *
 *  Le contrôle des ventilateurs vit dans un processus séparé (`pcia-fand`) ;
 *  s'il n'existe pas, un moteur embarqué peut prendre le relais — protégé par
 *  un verrou exclusif pour qu'il n'y ait jamais deux écrivains PWM.
 */

import { loadConfig, resolveWritablePaths } from './config.js';
import { createLogger, setLogFormat, setLogLevel } from './logger.js';
import { openAndMigrate } from './db/database.js';
import { createRepositories, seedDefaults } from './db/repositories.js';
import { AppState } from './app/state.js';
import { FanGateway } from './app/fanGateway.js';
import { FanHost } from './fan/host.js';
import { startEmbeddedFanHost } from './fan/embedded.js';
import { buildHttpServer, resolveStaticDir } from './http/server.js';
import { WsHub } from './http/ws.js';
import type { ApiContext } from './http/context.js';
import { canWriteDir, createRuntimeEnv, gpuProviderFor } from './runtime.js';
import { seedDemoCalibration } from './demo/calibration.js';
import type { SimulatedHwmonBackend } from './hwmon/simulated.js';
import type { ServerSnapshot, WsMessageType } from './contract.js';

const log = createLogger('server');

async function main(): Promise<void> {
  const loaded = loadConfig();
  const resolved = resolveWritablePaths(loaded.config, canWriteDir);
  const config = resolved.config;

  setLogLevel(config.logging.level);
  setLogFormat(config.logging.format);
  for (const w of [...loaded.warnings, ...resolved.warnings]) log.warn(w);

  const env = createRuntimeEnv(config);
  const db = openAndMigrate(config.storage.databasePath);
  const repos = createRepositories(db);
  seedDefaults(repos);
  if (env.demo) seedDemoCalibration(repos, env.hwmon as SimulatedHwmonBackend);

  // ---------- Moteur de ventilation ----------
  // En production (configuration livrée : `embedded: never`), rien n'est
  // construit ici : pcia-fan-control.service est l'unique moteur et le serveur
  // web le pilote par IPC.
  const embedded = startEmbeddedFanHost(config, () => new FanHost({
    config,
    repos,
    hwmon: env.hwmon,
    mode: env.mode,
    gpuProvider: gpuProviderFor(env),
  }));
  const embeddedFanHost = embedded.host;
  if (embedded.outcome === 'started') {
    log.info('Moteur de ventilation embarqué démarré', { mode: env.mode });
  }

  const fans = new FanGateway(config, embeddedFanHost);

  // ---------- WebSocket + état ----------
  let state: AppState;
  const ws = new WsHub(() => state.snapshot());

  state = new AppState({
    env,
    repos,
    embeddedFanHost,
    externalFanState: () => fans.lastState(),
    onSnapshot: (snapshot: ServerSnapshot) => ws.broadcast('snapshot', snapshot),
  });

  const ctx: ApiContext = {
    config,
    env,
    repos,
    state,
    fans,
    ws,
    publish(type?: WsMessageType) {
      const snapshot = state.refresh();
      if (type) ws.broadcast(type, { time: snapshot.time });
    },
    emit(type: WsMessageType, payload: unknown) {
      ws.broadcast(type, payload);
    },
  };

  // Le moteur embarqué diffuse son état sans attendre le prochain cycle.
  embeddedFanHost?.setStateListener((fanState) => ws.broadcast('fan_controller.health', fanState));

  await state.start();
  ws.start();

  const app = await buildHttpServer(ctx);
  await app.listen({ host: config.server.host, port: config.server.port });

  const staticDir = resolveStaticDir(config);
  log.info('PCIA Control Center prêt', {
    url: `http://${config.server.host === '0.0.0.0' ? '<IP_PCIA>' : config.server.host}:${config.server.port}/`,
    mode: env.mode,
    degraded: env.degraded,
    frontend: staticDir ?? 'non compilé',
    fanEngine: embeddedFanHost ? 'embarqué' : fans.available() ? 'externe' : 'absent',
    database: config.storage.databasePath,
  });
  if (env.mode === 'demo') {
    log.warn('MODE DÉMONSTRATION ACTIF : les données affichées sont simulées.');
  }
  if (config.security.lanOnly) {
    log.info('Accès restreint au réseau local (security.lan_only = true).');
  }

  // ---------- Arrêt ordonné ----------
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Signal reçu — arrêt ordonné', { signal });
    try {
      state.stop();
      ws.stop();
      await app.close();
      // Le moteur embarqué restitue les sorties au BIOS avant de rendre la main.
      if (embeddedFanHost) await embeddedFanHost.stop();
      repos.events.append({
        category: 'config', level: 'normal', targetLabel: 'PCIA Control Center', message: 'Back-end arrêté',
      });
    } catch (err) {
      log.error('Arrêt incomplet', { error: err });
    } finally {
      db.close();
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('Rejet non géré', { reason }));
  process.on('uncaughtException', (err) => log.error('Exception non capturée', { error: err }));
}

main().catch((err) => {
  log.error('Démarrage impossible', { error: err });
  process.exit(1);
});
