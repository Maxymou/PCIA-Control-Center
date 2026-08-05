/** Construction de l'environnement d'exécution commun à l'API et au moteur.
 *
 *  Résout le mode (matériel / démonstration) et fournit le backend hwmon
 *  correspondant. Le mode **matériel n'est jamais silencieusement simulé** :
 *  s'il manque des sources, le back-end reste en mode matériel et signale la
 *  dégradation, il ne bascule pas en données factices.
 */

import { accessSync, constants, mkdirSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { createLogger, setLogFormat, setLogLevel } from './logger.js';
import type { HwmonBackend } from './hwmon/backend.js';
import { SysfsHwmonBackend } from './hwmon/sysfs.js';
import { SimulatedHwmonBackend } from './hwmon/simulated.js';
import { DemoWorld } from './demo/world.js';

const log = createLogger('runtime');

export interface RuntimeEnv {
  config: AppConfig;
  mode: 'hardware' | 'demo';
  /** Mode matériel avec des capacités manquantes. */
  degraded: boolean;
  degradedReasons: string[];
  hwmon: HwmonBackend;
  /** Monde simulé, uniquement en mode démonstration. */
  demo: DemoWorld | null;
}

export function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Même question, **sans rien créer**.
 *
 *  Réservé aux commandes de diagnostic : `pcia-control-center status` ne doit
 *  pas laisser derrière lui un ~/.local/state/pcia-control-center vide, créé
 *  uniquement parce qu'il a testé s'il pouvait écrire quelque part. */
export function canWriteDirReadOnly(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function createRuntimeEnv(config: AppConfig): RuntimeEnv {
  setLogLevel(config.logging.level);
  setLogFormat(config.logging.format);

  const hwmonAvailable = SysfsHwmonBackend.available();
  const requested = config.mode.type;
  const mode: 'hardware' | 'demo' = requested === 'demo'
    ? 'demo'
    : requested === 'hardware'
      ? 'hardware'
      : hwmonAvailable ? 'hardware' : 'demo';

  if (requested === 'auto') {
    log.info('Mode résolu automatiquement', { mode, hwmonAvailable });
  }

  if (mode === 'demo') {
    const demo = new DemoWorld({ gtxInstalled: config.mode.demoGtxInstalled });
    const hwmon = new SimulatedHwmonBackend();
    demo.attachHwmon(hwmon);
    hwmon.discover();
    log.warn('MODE DÉMONSTRATION : toutes les données sont simulées, aucune action n’atteint le matériel.');
    return { config, mode, degraded: false, degradedReasons: [], hwmon, demo };
  }

  const hwmon = new SysfsHwmonBackend();
  const discovery = hwmon.discover();
  const reasons: string[] = [];
  if (!hwmonAvailable) reasons.push('/sys/class/hwmon inaccessible : aucun capteur ni sortie PWM.');
  if (discovery.pwmOutputs.length === 0) reasons.push('Aucune sortie PWM détectée : supervision uniquement.');
  else if (!discovery.pwmOutputs.some((o) => o.writable)) {
    reasons.push('Sorties PWM non inscriptibles : contrôle de ventilation indisponible (permissions).');
  }
  if (discovery.tempSensors.length === 0) reasons.push('Aucun capteur de température hwmon détecté.');
  for (const w of discovery.warnings) reasons.push(w);

  if (reasons.length > 0) {
    log.warn('Mode matériel dégradé', { reasons });
  }

  return { config, mode, degraded: reasons.length > 0, degradedReasons: reasons, hwmon, demo: null };
}

/** Fournisseur GPU adapté au mode (nvidia-smi réel ou monde simulé). */
export function gpuProviderFor(env: RuntimeEnv) {
  return env.demo ? () => env.demo!.gpus() : undefined;
}

/** Fournisseur stockage adapté au mode. */
export function storageProviderFor(env: RuntimeEnv) {
  return env.demo ? () => env.demo!.storage() : undefined;
}
