/** Mappage déclaratif « sortie logique ↔ matériel hwmon ».
 *
 *  Le problème que ce module résout : une sortie logique (CPU_FAN1, SYS_FAN3…)
 *  doit désigner un `pwmN` et un `fanN_input` précis, sur cette machine, sans
 *  dépendre du numéro `hwmonN` — celui-ci est attribué dans l'ordre de sondage
 *  des pilotes et change d'un redémarrage à l'autre.
 *
 *  Trois façons de désigner le matériel, de la plus robuste à la plus explicite :
 *    1. `controller: { name: nct6798 }` + `pwm: 3`   — identification par pilote ;
 *    2. `controller: { address: nct6775.2592 }`       — identification par device ;
 *    3. `pwm_path: /sys/.../hwmon/hwmon4/pwm3`        — chemin explicite, dont le
 *       segment `hwmonN` est **neutralisé** à la résolution (cf. `deviceSignature`).
 *
 *  Ce module ne lit ni n'écrit aucun fichier de contrôle : il ne fait que
 *  rapprocher une configuration d'une découverte déjà effectuée. Il ne décide
 *  jamais d'une prise de contrôle — cela reste le rôle exclusif de la
 *  calibration, qui vérifie physiquement la sortie et le retour au BIOS.
 */

import type { ControllerMatch, FanMappingEntry } from '../config.js';
import type { ControllerIdentity, FanId, HwmonDiscovery } from '../contract.js';

/** Entrée tachymétrique connue du backend (`fanN_input`). */
export interface TachCandidate {
  key: string;
  controllerKey: string;
  index: number;
  path: string;
}

/** Origine de la liaison retenue pour une sortie logique. */
export type MappingSource = 'config' | 'calibration' | 'none';

export interface ResolvedEntry<K extends string = string> {
  /** Clé déclarée : identifiant de sortie logique, ou nom de connecteur. */
  fanId: K;
  /** Sortie PWM désignée par la configuration, ou `null` si non résolue. */
  outputKey: string | null;
  /** Canal RPM imposé : clé de tachymètre, `null` = « aucun » explicite,
   *  `undefined` = la configuration ne se prononce pas (défaut conservé). */
  tachKey: string | null | undefined;
  /** Nom du connecteur physique, tel qu'annoncé dans la configuration. */
  connectorLabel: string | null;
  /** Une entrée existait mais n'a pas pu être rapprochée du matériel présent. */
  unresolved: boolean;
  warnings: string[];
}

/** Résolution d'une sortie logique (CPU_FAN1…SYS_FAN4). */
export type ResolvedFanMapping = ResolvedEntry<FanId>;

/** Résolution d'un connecteur déclaré non raccordé (PUMP_FAN1…). */
export type ResolvedUnconnected = ResolvedEntry<string>;

export interface ResolveOptions {
  /** Résolution des liens symboliques. Injectable pour les tests. */
  realpath?: (p: string) => string;
}

/** Signature d'un fichier de contrôle, indépendante du numéro hwmon.
 *
 *  `/sys/class/hwmon/hwmon4/pwm3` est un lien vers
 *  `/sys/devices/platform/nct6775.2592/hwmon/hwmon4/pwm3`. Le device
 *  (`nct6775.2592`) est stable ; `hwmon4` ne l'est pas. On retient donc
 *  « device + nom de fichier », ce qui survit à une renumérotation. */
export function deviceSignature(path: string, realpath?: (p: string) => string): string {
  let full = path;
  if (realpath) {
    try {
      full = realpath(path);
    } catch {
      // Chemin absent (matériel disparu, configuration périmée) : on continue
      // avec le chemin brut. La comparaison échouera proprement.
    }
  }
  const normalized = full.replace(/\/+$/, '');
  const m = /^(.*)\/hwmon\/hwmon\d+\/([^/]+)$/.exec(normalized);
  if (m) return `${m[1]}::${m[2]}`;
  // Contrôleur sans répertoire `device` intermédiaire : on retire le seul
  // segment hwmonN présent, faute de mieux.
  const flat = /^(.*)\/hwmon\d+\/([^/]+)$/.exec(normalized);
  if (flat) return `${flat[1]}::${flat[2]}`;
  return normalized;
}

/** Un contrôleur découvert satisfait-il les critères demandés ?
 *  Tous les critères fournis doivent correspondre (ET logique). */
export function controllerMatches(identity: ControllerIdentity, match: ControllerMatch): boolean {
  const eq = (expected: string | undefined, actual: string | null): boolean =>
    expected === undefined || expected.toLowerCase() === (actual ?? '').toLowerCase();
  return eq(match.key, identity.key)
    && eq(match.name, identity.driverName)
    && eq(match.driver, identity.kernelDriver)
    && eq(match.bus, identity.bus)
    && eq(match.address, identity.address);
}

/** Critères d'identification effectifs d'une entrée.
 *
 *  Deux écritures équivalentes sont acceptées dans config.yaml : la forme
 *  imbriquée `controller: { name, driver, address }` et les clés plates
 *  `controller_name`, `kernel_driver`, `controller_address`. Le repliage se
 *  fait ici, et **seulement ici** — c'est ce qui garantit que les deux formes
 *  ne peuvent pas diverger avec le temps. La forme imbriquée l'emporte si les
 *  deux sont présentes. */
export function controllerMatchOf(entry: FanMappingEntry): ControllerMatch | null {
  const flat: ControllerMatch = {
    name: entry.controllerName,
    driver: entry.kernelDriver,
    address: entry.controllerAddress,
    bus: entry.controllerBus,
  };
  const merged: ControllerMatch = { ...flat, ...(entry.controller ?? {}) };
  return Object.values(merged).some((v) => v !== undefined) ? merged : null;
}

function resolveOne<K extends string>(
  fanId: K,
  entry: FanMappingEntry,
  discovery: HwmonDiscovery,
  tachs: TachCandidate[],
  opts: ResolveOptions,
): ResolvedEntry<K> {
  const warnings: string[] = [];
  const label = entry.label ?? null;
  const outputs = discovery.pwmOutputs;
  let matched: (typeof outputs)[number] | null = null;

  if (entry.pwmPath) {
    const wanted = deviceSignature(entry.pwmPath, opts.realpath);
    const hits = outputs.filter((o) => deviceSignature(o.pwmPath, opts.realpath) === wanted);
    if (hits.length === 1) matched = hits[0];
    else if (hits.length === 0) {
      warnings.push(`${fanId} : aucun contrôleur ne correspond au chemin ${entry.pwmPath}.`);
    } else {
      warnings.push(`${fanId} : le chemin ${entry.pwmPath} désigne ${hits.length} sorties — mappage ignoré.`);
    }
  } else if (controllerMatchOf(entry)) {
    const match = controllerMatchOf(entry)!;
    let candidates = outputs.filter((o) => controllerMatches(o.controller, match));
    if (entry.pwm !== undefined) candidates = candidates.filter((o) => o.index === entry.pwm);
    if (candidates.length === 1) matched = candidates[0];
    else if (candidates.length === 0) {
      warnings.push(
        `${fanId} : aucune sortie PWM ne correspond aux critères (${describeMatch(match)}`
        + `${entry.pwm !== undefined ? `, pwm${entry.pwm}` : ''}).`,
      );
    } else {
      warnings.push(
        `${fanId} : ${candidates.length} sorties correspondent aux critères — préciser \`pwm\` ou \`pwm_path\`.`,
      );
    }
  }

  if (!matched) {
    return { fanId, outputKey: null, tachKey: undefined, connectorLabel: label, unresolved: true, warnings };
  }

  // --- Canal RPM ---
  let tachKey: string | null | undefined;
  if (entry.tachPath) {
    const wanted = deviceSignature(entry.tachPath, opts.realpath);
    const hit = tachs.find((t) => deviceSignature(t.path, opts.realpath) === wanted);
    if (hit) tachKey = hit.key;
    else {
      tachKey = null;
      warnings.push(`${fanId} : canal RPM ${entry.tachPath} introuvable — vitesse annoncée indisponible.`);
    }
  } else if (entry.tach === null) {
    // Déclaration explicite « cette sortie n'a pas de tachymètre ».
    tachKey = null;
  } else if (entry.tach !== undefined) {
    const hit = tachs.find((t) => t.controllerKey === matched!.controller.key && t.index === entry.tach);
    if (hit) tachKey = hit.key;
    else {
      tachKey = null;
      warnings.push(
        `${fanId} : le canal fan${entry.tach}_input n'existe pas sur ${matched.controller.driverName} `
        + '— vitesse annoncée indisponible.',
      );
    }
  }

  return { fanId, outputKey: matched.key, tachKey, connectorLabel: label, unresolved: false, warnings };
}

function describeMatch(match: ControllerMatch): string {
  return Object.entries(match).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ')
    || 'aucun critère';
}

/** Résout tout le mappage déclaré. Les sorties absentes de la configuration ne
 *  produisent aucune entrée : leur comportement historique est inchangé. */
export function resolveFanMapping<K extends string = FanId>(
  mapping: Partial<Record<K, FanMappingEntry>>,
  discovery: HwmonDiscovery,
  tachs: TachCandidate[],
  opts: ResolveOptions = {},
): Map<K, ResolvedEntry<K>> {
  const out = new Map<K, ResolvedEntry<K>>();
  const usedOutputs = new Map<string, K>();

  for (const [id, entry] of Object.entries(mapping) as [K, FanMappingEntry][]) {
    if (!entry) continue;
    const resolved = resolveOne(id, entry, discovery, tachs, opts);
    if (resolved.outputKey) {
      const previous = usedOutputs.get(resolved.outputKey);
      if (previous) {
        // Deux sorties logiques sur le même PWM : la seconde est refusée. Laisser
        // passer reviendrait à piloter un ventilateur avec deux courbes.
        resolved.warnings.push(
          `${id} : la sortie ${resolved.outputKey} est déjà attribuée à ${previous} — mappage de ${id} ignoré.`,
        );
        resolved.outputKey = null;
        resolved.tachKey = undefined;
        resolved.unresolved = true;
      } else {
        usedOutputs.set(resolved.outputKey, id);
      }
    }
    out.set(id, resolved);
  }
  return out;
}

/** Rassemble toutes les entrées tachymétriques connues d'un backend. */
export function collectTachs(
  discovery: HwmonDiscovery,
  tachKeysForController: (controllerKey: string) => { key: string; index: number; path: string }[],
): TachCandidate[] {
  const out: TachCandidate[] = [];
  for (const controller of discovery.controllers) {
    for (const t of tachKeysForController(controller.key)) {
      out.push({ key: t.key, controllerKey: controller.key, index: t.index, path: t.path });
    }
  }
  return out;
}
