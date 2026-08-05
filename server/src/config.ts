/** Configuration de PCIA Control Center.
 *
 *  Ordre de priorité (du plus faible au plus fort) :
 *    1. valeurs par défaut ci-dessous ;
 *    2. fichier YAML (/etc/pcia-control-center/config.yaml, ou $PCIA_CONFIG) ;
 *    3. variables d'environnement PCIA_*.
 *
 *  Aucune donnée modifiable n'est stockée dans le dépôt : la base et les états
 *  runtime vont dans /var/lib et /run (voir `resolvePaths`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LogLevel } from './logger.js';

export type RunMode = 'hardware' | 'demo' | 'auto';

const serverSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(4321),
  /** Origines autorisées pour les requêtes cross-origin (dev Vite). */
  corsOrigins: z.array(z.string()).default([]),
  /** Répertoire du front-end compilé. Résolu automatiquement si absent. */
  staticDir: z.string().optional(),
});

const modeSchema = z.object({
  /** `auto` : matériel si /sys/class/hwmon est lisible, sinon démo (annoncé). */
  type: z.enum(['hardware', 'demo', 'auto']).default('auto'),
  /** En mode démo : GTX 1080 simulée présente ou non. */
  demoGtxInstalled: z.boolean().default(true),
});

const storageSchema = z.object({
  databasePath: z.string().default('/var/lib/pcia-control-center/pcia.db'),
  /** Répertoire runtime : socket du moteur de ventilation, fichier d'état. */
  runtimeDir: z.string().default('/run/pcia-control-center'),
});

const historySchema = z.object({
  /** Rétention des mesures détaillées. La fenêtre servie au front est de 60 min. */
  retentionHours: z.number().min(1).max(24 * 30).default(24),
  /** Pas d'échantillonnage de l'historique (le front affiche un point / 10 s). */
  sampleIntervalMs: z.number().int().min(1000).default(10_000),
  /** Purge périodique. */
  purgeIntervalMs: z.number().int().min(60_000).default(15 * 60_000),
});

const collectorSchema = z.object({
  sensorsIntervalMs: z.number().int().min(500).default(2000),
  powerIntervalMs: z.number().int().min(1000).default(4000),
  storageIntervalMs: z.number().int().min(2000).default(20_000),
  servicesIntervalMs: z.number().int().min(2000).default(10_000),
  connectionsIntervalMs: z.number().int().min(2000).default(10_000),
  /** Ré-inventaire matériel (apparition/disparition de GPU). */
  inventoryIntervalMs: z.number().int().min(10_000).default(60_000),
});

const fanControlSchema = z.object({
  loopIntervalMs: z.number().int().min(500).max(5000).default(1000),
  /** Consigne appliquée quand un capteur est temporairement indisponible. */
  sensorFailurePwm: z.number().int().min(0).max(100).default(80),
  /** Consigne appliquée en situation critique / capteur durablement perdu. */
  criticalPwm: z.number().int().min(0).max(100).default(100),
  /** Délai avant de considérer un capteur comme durablement indisponible. */
  sensorGraceMs: z.number().int().min(1000).default(15_000),
  /** Interdit le passage automatique sous contrôle logiciel sans retour BIOS validé. */
  requireBiosReturnValidation: z.boolean().default(true),
  /** Détection de ventilateur bloqué. */
  stall: z.object({
    pwmThreshold: z.number().int().min(1).max(100).default(30),
    delayMs: z.number().int().min(1000).default(10_000),
    consecutiveReads: z.number().int().min(2).default(3),
  }).prefault({}),
  /** Nombre d'échecs d'écriture PWM consécutifs avant passage en FAILSAFE. */
  maxWriteFailures: z.number().int().min(1).default(3),
  /** Plancher PWM par défaut pour les ventilateurs refroidissant un GPU passif. */
  passiveGpuFloorPwm: z.number().int().min(0).max(100).default(35),
  /** Le moteur publie un heartbeat à cet intervalle. */
  heartbeatIntervalMs: z.number().int().min(500).default(2000),
  /** Au-delà, l'API considère le moteur hors ligne. */
  heartbeatTimeoutMs: z.number().int().min(2000).default(8000),
  /** Consigne appliquée juste avant restitution au BIOS lors d'un arrêt propre. */
  shutdownPwm: z.number().int().min(0).max(100).default(70),
  /** Moteur embarqué dans l'API :
   *  - `auto`   : uniquement si aucun daemon `pcia-fand` ne détient le verrou ;
   *  - `always` : toujours (déploiement mono-processus) ;
   *  - `never`  : jamais (le daemon systemd est obligatoire).
   *  Un verrou exclusif garantit qu'un seul moteur écrit les PWM. */
  embedded: z.enum(['auto', 'always', 'never']).default('auto'),
});

const calibrationSchema = z.object({
  /** Durées (s) des paliers du test d'identification physique. */
  identifyStepSeconds: z.number().int().min(2).max(30).default(6),
  identifyLowPwm: z.number().int().min(0).max(100).default(70),
  identifyHighPwm: z.number().int().min(0).max(100).default(100),
  /** Détection du minimum : palier et décrément. */
  minimumStepSeconds: z.number().int().min(2).max(30).default(6),
  minimumDecrement: z.number().int().min(1).max(20).default(5),
  minimumSafetyMargin: z.number().int().min(0).max(30).default(10),
  /** Attente d'observation lors du test de retour BIOS. */
  biosReturnObserveSeconds: z.number().int().min(3).max(60).default(12),
  /** Température au-delà de laquelle toute calibration est refusée/interrompue. */
  abortTemperatureC: z.number().min(40).max(110).default(85),
});

// ---------------------------------------------------------------------
// Mappage sorties logiques ↔ matériel hwmon
// ---------------------------------------------------------------------

/** Critères d'identification d'un contrôleur hwmon.
 *
 *  Jamais « hwmon4 » : ce numéro est attribué dans l'ordre de sondage des
 *  pilotes et change d'un démarrage à l'autre. On désigne le contrôleur par ce
 *  qui ne bouge pas — son `name`, son pilote noyau, son bus, son adresse. */
const controllerMatchSchema = z.object({
  /** Contenu de `/sys/class/hwmon/hwmonN/name` (ex. nct6798, it8686). */
  name: z.string().min(1).optional(),
  /** Pilote noyau réel (`device/driver`, ex. nct6775). */
  driver: z.string().min(1).optional(),
  /** Sous-système du device (platform, pci, i2c…). */
  bus: z.string().min(1).optional(),
  /** Adresse sur le bus (ex. nct6775.2592, 0000:00:1f.3). */
  address: z.string().min(1).optional(),
  /** Empreinte exacte produite par `pcia-cli discover` (la plus précise). */
  key: z.string().min(1).optional(),
}).refine(
  (m) => Boolean(m.name || m.driver || m.bus || m.address || m.key),
  { message: 'au moins un critère d’identification est requis (name, driver, bus, address ou key)' },
);

export type ControllerMatch = z.infer<typeof controllerMatchSchema>;

/** Description d'une sortie logique : quel PWM, quel canal RPM. */
const fanMappingEntrySchema = z.object({
  /** Nom du connecteur physique tel qu'il est sérigraphié sur la carte mère. */
  label: z.string().min(1).max(60).optional(),
  controller: controllerMatchSchema.optional(),
  /** Index de la sortie (`pwm3` → 3). Sans valeur de `controller`, ignoré. */
  pwm: z.number().int().min(0).max(31).optional(),
  /** Index du tachymètre (`fan2_input` → 2). `null` = pas de retour RPM.
   *  Absent = on garde la corrélation établie par la calibration. */
  tach: z.number().int().min(0).max(31).nullable().optional(),
  /** Chemin explicite vers le fichier pwmN. Le numéro hwmon qu'il contient est
   *  neutralisé à la résolution : seul le device sous-jacent compte. */
  pwmPath: z.string().min(1).optional(),
  /** Chemin explicite vers le fichier fanN_input. */
  tachPath: z.string().min(1).optional(),
}).refine(
  (e) => Boolean(e.controller || e.pwmPath),
  { message: 'préciser `controller` (avec `pwm`) ou `pwm_path`' },
);

export type FanMappingEntry = z.infer<typeof fanMappingEntrySchema>;

/** Identifiants des sorties logiques. Dupliqué volontairement depuis
 *  `contract.ts` : la configuration se charge avant tout le reste et ne doit
 *  dépendre d'aucun module applicatif. La conformité est vérifiée par un test. */
export const CONFIGURABLE_FAN_IDS = ['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'] as const;

const fansSchema = z.object({
  /** Mappage déclaratif. Toute sortie absente conserve le comportement
   *  historique : liaison établie par l'assistant de calibration uniquement. */
  mapping: z.partialRecord(z.enum(CONFIGURABLE_FAN_IDS), fanMappingEntrySchema).default({}),
});

const alertsSchema = z.object({
  /** Seuils [attention, critique] par identifiant matériel du front-end. */
  temperatureThresholds: z.record(z.string(), z.tuple([z.number(), z.number()])).default({
    cpu: [75, 88],
    nvme: [60, 72],
    'v100-1': [80, 88],
    'v100-2': [80, 88],
    gtx1080: [78, 88],
    motherboard: [55, 65],
    'case-front': [45, 55],
    'case-rear': [48, 58],
  }),
  /** Température provoquant une consigne 100 % immédiate (sécurité moteur). */
  criticalTemperatureC: z.number().min(50).max(110).default(90),
});

const securitySchema = z.object({
  /** Refuse les requêtes provenant d'adresses non privées. */
  lanOnly: z.boolean().default(true),
  /** Protection des actions sensibles : 'none' (LAN de confiance) ou 'token'. */
  authMode: z.enum(['none', 'token']).default('none'),
  /** Jeton partagé, si authMode = token. Jamais journalisé ni exporté. */
  token: z.string().optional(),
  /** Autorise les actions sensibles (calibration, PWM…) via l'API. */
  allowSensitiveActions: z.boolean().default(true),
});

const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'text']).default('json'),
});

export const configSchema = z.object({
  server: serverSchema.prefault({}),
  mode: modeSchema.prefault({}),
  storage: storageSchema.prefault({}),
  history: historySchema.prefault({}),
  collector: collectorSchema.prefault({}),
  fanControl: fanControlSchema.prefault({}),
  fans: fansSchema.prefault({}),
  calibration: calibrationSchema.prefault({}),
  alerts: alertsSchema.prefault({}),
  security: securitySchema.prefault({}),
  logging: loggingSchema.prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;

const DEFAULT_CONFIG_PATHS = [
  '/etc/pcia-control-center/config.yaml',
  '/etc/pcia-control-center/config.yml',
];

/** Sections dont les clés sont des *identifiants*, pas des noms d'options.
 *
 *  Sans cette liste, `case-front` devenait `caseFront` et `v100-1` devenait
 *  `v1001` : les seuils saisis par l'utilisateur étaient silencieusement rangés
 *  sous une clé qui ne correspondait à aucun matériel, donc jamais appliqués.
 *  Seules les clés directement filles de ces chemins sont préservées ; leur
 *  contenu, lui, reste normalisé (`pwm_path` → `pwmPath`). */
const IDENTIFIER_KEY_PATHS = new Set([
  'alerts.temperatureThresholds',
  'fans.mapping',
]);

/** Accepte les clés YAML en snake_case comme en camelCase. */
function camelize(input: unknown, path: string[] = []): unknown {
  if (Array.isArray(input)) return input.map((v) => camelize(v, path));
  if (input && typeof input === 'object') {
    const verbatim = IDENTIFIER_KEY_PATHS.has(path.join('.'));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = verbatim ? k : k.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      out[key] = camelize(v, [...path, key]);
    }
    return out;
  }
  return input;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const prev = out[k];
    out[k] = prev && typeof prev === 'object' && !Array.isArray(prev) ? deepMerge(prev, v) : v;
  }
  return out as T;
}

function envOverrides(): Record<string, unknown> {
  const e = process.env;
  const patch: Record<string, unknown> = {};
  const set = (path: string[], value: unknown) => {
    let node = patch;
    for (const p of path.slice(0, -1)) {
      node[p] = (node[p] as Record<string, unknown>) ?? {};
      node = node[p] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
  };
  if (e.PCIA_HOST) set(['server', 'host'], e.PCIA_HOST);
  if (e.PCIA_PORT) set(['server', 'port'], Number(e.PCIA_PORT));
  if (e.PCIA_STATIC_DIR) set(['server', 'staticDir'], e.PCIA_STATIC_DIR);
  if (e.PCIA_CORS_ORIGINS) set(['server', 'corsOrigins'], e.PCIA_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  if (e.PCIA_MODE) set(['mode', 'type'], e.PCIA_MODE);
  if (e.PCIA_DB) set(['storage', 'databasePath'], e.PCIA_DB);
  if (e.PCIA_RUNTIME_DIR) set(['storage', 'runtimeDir'], e.PCIA_RUNTIME_DIR);
  if (e.PCIA_LOG_LEVEL) set(['logging', 'level'], e.PCIA_LOG_LEVEL);
  if (e.PCIA_LOG_FORMAT) set(['logging', 'format'], e.PCIA_LOG_FORMAT);
  if (e.PCIA_LAN_ONLY) set(['security', 'lanOnly'], e.PCIA_LAN_ONLY !== 'false' && e.PCIA_LAN_ONLY !== '0');
  if (e.PCIA_AUTH_MODE) set(['security', 'authMode'], e.PCIA_AUTH_MODE);
  if (e.PCIA_TOKEN) set(['security', 'token'], e.PCIA_TOKEN);
  if (e.PCIA_REQUIRE_BIOS_RETURN) {
    set(['fanControl', 'requireBiosReturnValidation'], e.PCIA_REQUIRE_BIOS_RETURN !== 'false' && e.PCIA_REQUIRE_BIOS_RETURN !== '0');
  }
  return patch;
}

export interface LoadedConfig {
  config: AppConfig;
  /** Chemin du fichier YAML effectivement chargé, si présent. */
  sourceFile: string | null;
  warnings: string[];
}

/** Racine du dépôt / de l'installation, déduite de l'emplacement du bundle. */
export function appRoot(): string {
  // dist-server/server/src/config.js  -> remonte de 3 niveaux
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

/** Répertoires de repli quand /var/lib et /run ne sont pas accessibles en écriture. */
function userFallbackPaths(): { db: string; runtime: string } {
  const base = process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'pcia-control-center')
    : join(homedir(), '.local', 'state', 'pcia-control-center');
  return { db: join(base, 'pcia.db'), runtime: join(base, 'run') };
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const warnings: string[] = [];
  const candidates = [explicitPath, process.env.PCIA_CONFIG, ...DEFAULT_CONFIG_PATHS].filter(Boolean) as string[];
  let fileData: unknown = {};
  let sourceFile: string | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      fileData = camelize(parseYaml(readFileSync(candidate, 'utf8')) ?? {});
      sourceFile = candidate;
    } catch (err) {
      warnings.push(`Fichier de configuration illisible (${candidate}) : ${(err as Error).message}`);
    }
    break;
  }

  const merged = deepMerge(deepMerge({}, fileData), envOverrides());
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    warnings.push(`Configuration invalide, valeurs par défaut utilisées : ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return { config: configSchema.parse({}), sourceFile, warnings };
  }
  return { config: parsed.data, sourceFile, warnings };
}

/** Ajuste les chemins de stockage si les emplacements système ne sont pas accessibles. */
export function resolveWritablePaths(config: AppConfig, canWrite: (dir: string) => boolean): { config: AppConfig; warnings: string[] } {
  const warnings: string[] = [];
  const fallback = userFallbackPaths();
  const next = structuredClone(config);
  if (!canWrite(dirname(next.storage.databasePath))) {
    warnings.push(`Base non inscriptible dans ${dirname(next.storage.databasePath)} — repli sur ${fallback.db}`);
    next.storage.databasePath = fallback.db;
  }
  if (!canWrite(next.storage.runtimeDir)) {
    warnings.push(`Répertoire runtime non inscriptible (${next.storage.runtimeDir}) — repli sur ${fallback.runtime}`);
    next.storage.runtimeDir = fallback.runtime;
  }
  return { config: next, warnings };
}

export function logLevelOf(config: AppConfig): LogLevel {
  return config.logging.level;
}

/** Chemin du socket de commande du moteur de ventilation. */
export function fanSocketPath(config: AppConfig): string {
  return join(config.storage.runtimeDir, 'fand.sock');
}

/** Chemin du fichier d'état publié par le moteur (heartbeat + état des sorties). */
export function fanStatePath(config: AppConfig): string {
  return join(config.storage.runtimeDir, 'fand-state.json');
}
