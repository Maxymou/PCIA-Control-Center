/** `pcia-fand` — daemon de contrôle des ventilateurs.
 *
 *  Processus **indépendant de l'API** : il lit sa configuration en base, ses
 *  capteurs directement, et pilote les sorties PWM. L'arrêt, le crash ou le
 *  redémarrage du serveur web n'a aucun effet sur la régulation.
 *
 *  À l'arrêt (SIGTERM), il applique une consigne sûre, restitue les sorties au
 *  BIOS, vérifie, journalise, puis quitte.
 */

import { loadConfig, resolveWritablePaths } from './config.js';
import { createLogger, setLogFormat, setLogLevel } from './logger.js';
import { openAndMigrate } from './db/database.js';
import { createRepositories, seedDefaults } from './db/repositories.js';
import { FanHost } from './fan/host.js';
import { canWriteDir, createRuntimeEnv, gpuProviderFor } from './runtime.js';
import { seedDemoCalibration } from './demo/calibration.js';
import type { SimulatedHwmonBackend } from './hwmon/simulated.js';

const log = createLogger('fand');

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

  log.info('Démarrage du moteur de ventilation', {
    mode: env.mode,
    database: config.storage.databasePath,
    runtimeDir: config.storage.runtimeDir,
    requireBiosReturnValidation: config.fanControl.requireBiosReturnValidation,
  });

  const host = new FanHost({
    config,
    repos,
    hwmon: env.hwmon,
    mode: env.mode,
    gpuProvider: gpuProviderFor(env),
  });

  // Le monde simulé doit avancer même sans API en mode démo.
  const demoTimer = env.demo
    ? setInterval(() => env.demo!.step(), config.fanControl.loopIntervalMs)
    : null;

  const started = host.start();
  if (!started.started) {
    log.error('Démarrage refusé : un autre moteur détient déjà le verrou', { pid: started.heldBy });
    if (demoTimer) clearInterval(demoTimer);
    db.close();
    process.exit(1);
  }

  repos.events.append({
    category: 'config',
    level: 'normal',
    targetLabel: 'Moteur de ventilation',
    message: `Moteur démarré (mode ${env.mode}).`,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Signal reçu — arrêt ordonné', { signal });
    if (demoTimer) clearInterval(demoTimer);
    try {
      await host.stop();
      repos.events.append({
        category: 'config',
        level: 'normal',
        targetLabel: 'Moteur de ventilation',
        message: 'Moteur arrêté — sorties restituées au BIOS.',
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
  process.on('uncaughtException', (err) => {
    // Ne pas mourir silencieusement : la ventilation est critique.
    log.error('Exception non capturée', { error: err });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Rejet non géré', { reason });
  });
}

main().catch((err) => {
  log.error('Démarrage impossible', { error: err });
  process.exit(1);
});
