/** Découverte et pilotage des contrôleurs hwmon réels (/sys/class/hwmon).
 *
 *  Aucun chemin n'est codé en dur au-delà de la racine `/sys/class/hwmon` :
 *  les contrôleurs, sorties PWM, entrées tachymétriques et capteurs sont
 *  énumérés à chaque découverte, et identifiés par une empreinte stable
 *  (pilote + bus + adresse + modalias) — jamais par « hwmon4 ».
 */

import { createHash } from 'node:crypto';
import {
  accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  ControllerIdentity, DiscoveredPwmOutput, DiscoveredTempSensor, HwmonDiscovery,
} from '../contract.js';
import { createLogger } from '../logger.js';
import { emptyDiscovery, HwmonBackend, HwmonError, percentToRaw, rawToPercent } from './backend.js';

const log = createLogger('hwmon.sysfs');

export const HWMON_ROOT = '/sys/class/hwmon';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function readInt(path: string): number | null {
  const raw = readText(path);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Le sous-système du device (pci, platform, i2c, acpi…). */
function subsystemOf(deviceDir: string): string | null {
  try {
    return basename(realpathSync(join(deviceDir, 'subsystem')));
  } catch {
    return null;
  }
}

function parseUevent(deviceDir: string): Record<string, string> {
  const raw = readText(join(deviceDir, 'uevent'));
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function driverOf(deviceDir: string): string | null {
  try {
    return basename(readlinkSync(join(deviceDir, 'driver')));
  } catch {
    return null;
  }
}

/** Empreinte stable d'un contrôleur.
 *
 *  On combine plusieurs éléments : si l'un manque (certains pilotes n'exposent
 *  pas `device`), les autres suffisent généralement à distinguer deux
 *  contrôleurs. Le chemin /sys courant n'entre jamais dans l'empreinte. */
function controllerKey(parts: {
  driverName: string; kernelDriver: string | null; bus: string | null;
  address: string | null; modalias: string | null;
}): string {
  const material = [
    parts.driverName,
    parts.kernelDriver ?? '',
    parts.bus ?? '',
    parts.address ?? '',
    parts.modalias ?? '',
  ].join('|');
  return `${parts.driverName}:${createHash('sha1').update(material).digest('hex').slice(0, 12)}`;
}

function identifyController(hwmonDir: string): ControllerIdentity {
  const driverName = readText(join(hwmonDir, 'name')) ?? basename(hwmonDir);
  const deviceDir = join(hwmonDir, 'device');
  const hasDevice = existsSync(deviceDir);
  const uevent = hasDevice ? parseUevent(deviceDir) : {};
  const kernelDriver = hasDevice ? driverOf(deviceDir) ?? uevent.DRIVER ?? null : null;
  const bus = hasDevice ? subsystemOf(deviceDir) : null;
  let address: string | null = null;
  if (hasDevice) {
    try {
      address = basename(realpathSync(deviceDir));
    } catch {
      address = uevent.PCI_SLOT_NAME ?? null;
    }
  }
  const modalias = uevent.MODALIAS ?? null;
  return {
    key: controllerKey({ driverName, kernelDriver, bus, address, modalias }),
    driverName,
    kernelDriver,
    bus,
    address,
    modalias,
    currentPath: hwmonDir,
  };
}

interface OutputPaths {
  pwmPath: string;
  enablePath: string | null;
  tachPath: string | null;
  tachKey: string | null;
  controllerKey: string;
  index: number;
}

interface TachEntry {
  key: string;
  controllerKey: string;
  index: number;
  path: string;
}

export interface SysfsBackendOptions {
  /** Racine alternative — utilisé par les tests avec une arborescence factice. */
  root?: string;
  /** Écriture réellement effectuée ? `false` = lecture seule stricte (diagnostic). */
  allowWrites?: boolean;
}

export class SysfsHwmonBackend implements HwmonBackend {
  readonly kind = 'sysfs' as const;

  private root: string;
  private allowWrites: boolean;
  private discovery: HwmonDiscovery = emptyDiscovery();
  private outputPaths = new Map<string, OutputPaths>();
  private tachs = new Map<string, TachEntry>();
  private tempPaths = new Map<string, string>();
  /** Liaisons tachymètre → sortie confirmées par la calibration. */
  private tachBindings = new Map<string, string | null>();

  constructor(opts: SysfsBackendOptions = {}) {
    this.root = opts.root ?? HWMON_ROOT;
    this.allowWrites = opts.allowWrites ?? true;
  }

  /** Vrai si la racine hwmon existe et est lisible. */
  static available(root = HWMON_ROOT): boolean {
    try {
      return statSync(root).isDirectory() && readdirSync(root).length >= 0;
    } catch {
      return false;
    }
  }

  discover(): HwmonDiscovery {
    const warnings: string[] = [];
    const controllers: ControllerIdentity[] = [];
    const pwmOutputs: DiscoveredPwmOutput[] = [];
    const tempSensors: DiscoveredTempSensor[] = [];
    const allTachs: TachEntry[] = [];
    const usedTachKeys = new Set<string>();

    this.outputPaths.clear();
    this.tachs.clear();
    this.tempPaths.clear();

    let entries: string[] = [];
    try {
      entries = readdirSync(this.root).filter((e) => e.startsWith('hwmon')).sort();
    } catch (err) {
      warnings.push(`Racine hwmon inaccessible (${this.root}) : ${(err as Error).message}`);
      this.discovery = emptyDiscovery(warnings);
      return this.discovery;
    }

    const seenKeys = new Map<string, number>();

    for (const entry of entries) {
      const hwmonDir = join(this.root, entry);
      let identity: ControllerIdentity;
      try {
        identity = identifyController(hwmonDir);
      } catch (err) {
        warnings.push(`Contrôleur ${entry} illisible : ${(err as Error).message}`);
        continue;
      }

      // Collision d'empreinte (contrôleurs vraiment identiques) : on suffixe
      // pour rester déterministe sur l'ordre d'énumération du noyau.
      const seen = seenKeys.get(identity.key) ?? 0;
      seenKeys.set(identity.key, seen + 1);
      if (seen > 0) {
        identity = { ...identity, key: `${identity.key}/${seen}` };
        warnings.push(`Deux contrôleurs partagent la même empreinte (${identity.driverName}) — suffixe d'ordre appliqué.`);
      }
      controllers.push(identity);

      let files: string[] = [];
      try {
        files = readdirSync(hwmonDir);
      } catch (err) {
        warnings.push(`Contenu de ${entry} illisible : ${(err as Error).message}`);
        continue;
      }

      // --- Entrées tachymétriques ---
      for (const file of files) {
        const m = /^fan(\d+)_input$/.exec(file);
        if (!m) continue;
        const index = Number(m[1]);
        const path = join(hwmonDir, file);
        const tach: TachEntry = { key: `${identity.key}#fan${index}`, controllerKey: identity.key, index, path };
        allTachs.push(tach);
        this.tachs.set(tach.key, tach);
      }

      // --- Capteurs de température ---
      for (const file of files) {
        const m = /^temp(\d+)_input$/.exec(file);
        if (!m) continue;
        const index = Number(m[1]);
        const path = join(hwmonDir, file);
        const key = `${identity.key}#temp${index}`;
        const raw = readInt(path);
        this.tempPaths.set(key, path);
        tempSensors.push({
          key,
          controller: identity,
          index,
          path,
          label: readText(join(hwmonDir, `temp${index}_label`)),
          // Les pilotes exposent des milli-degrés.
          valueC: raw === null ? null : Math.round((raw / 1000) * 10) / 10,
          mappedTo: null,
        });
      }

      // --- Sorties PWM ---
      for (const file of files) {
        const m = /^pwm(\d+)$/.exec(file);
        if (!m) continue;
        const index = Number(m[1]);
        const pwmPath = join(hwmonDir, file);
        const enableCandidate = join(hwmonDir, `pwm${index}_enable`);
        const enablePath = existsSync(enableCandidate) ? enableCandidate : null;
        const key = `${identity.key}#pwm${index}`;

        // Corrélation tachymétrique : le même index n'est qu'un *candidat*.
        // Elle n'est retenue que si la calibration la confirme (bindTach).
        const bound = this.tachBindings.get(key);
        const candidate = allTachs.find((t) => t.controllerKey === identity.key && t.index === index) ?? null;
        const tach = bound === undefined
          ? candidate
          : bound === null ? null : (this.tachs.get(bound) ?? null);
        if (tach) usedTachKeys.add(tach.key);

        const raw = readInt(pwmPath);
        this.outputPaths.set(key, {
          pwmPath,
          enablePath,
          tachPath: tach?.path ?? null,
          tachKey: tach?.key ?? null,
          controllerKey: identity.key,
          index,
        });
        pwmOutputs.push({
          key,
          controller: identity,
          index,
          pwmPath,
          enablePath,
          // Les modes acceptés ne sont pas énumérables via sysfs : ils sont
          // établis par sondage lors de la calibration, jamais supposés.
          supportedEnableModes: [],
          currentEnableMode: enablePath ? readInt(enablePath) : null,
          currentPwm: raw === null ? null : rawToPercent(raw),
          tachPath: tach?.path ?? null,
          tachIndex: tach?.index ?? null,
          currentRpm: tach ? readInt(tach.path) : null,
          label: readText(join(hwmonDir, `pwm${index}_label`)) ?? readText(join(hwmonDir, `fan${index}_label`)),
          writable: this.allowWrites && isWritable(pwmPath),
        });
      }
    }

    const orphanTachs = allTachs
      .filter((t) => !usedTachKeys.has(t.key))
      .map((t) => ({
        key: t.key,
        controller: controllers.find((c) => c.key === t.controllerKey)!,
        index: t.index,
        path: t.path,
        rpm: readInt(t.path),
      }));

    if (pwmOutputs.length === 0) {
      warnings.push('Aucune sortie PWM détectée : supervision uniquement, pas de contrôle de ventilation.');
    }
    if (pwmOutputs.length > 0 && !pwmOutputs.some((o) => o.writable)) {
      warnings.push('Sorties PWM détectées mais non inscriptibles : vérifier les permissions (groupe/règle udev).');
    }

    this.discovery = { controllers, pwmOutputs, tempSensors, orphanTachs, warnings };
    log.info('Découverte hwmon', {
      controllers: controllers.length,
      pwmOutputs: pwmOutputs.length,
      tempSensors: tempSensors.length,
      writable: pwmOutputs.filter((o) => o.writable).length,
    });
    return this.discovery;
  }

  cached(): HwmonDiscovery {
    return this.discovery;
  }

  getOutput(key: string): DiscoveredPwmOutput | null {
    return this.discovery.pwmOutputs.find((o) => o.key === key) ?? null;
  }

  getTempSensor(key: string): DiscoveredTempSensor | null {
    return this.discovery.tempSensors.find((s) => s.key === key) ?? null;
  }

  private paths(key: string): OutputPaths {
    const p = this.outputPaths.get(key);
    if (!p) throw new HwmonError(`Sortie PWM inconnue : ${key}`, 'NOT_FOUND');
    return p;
  }

  readPwmPercent(key: string): number | null {
    const raw = readInt(this.paths(key).pwmPath);
    return raw === null ? null : rawToPercent(raw);
  }

  writePwmPercent(key: string, percent: number): void {
    if (!Number.isFinite(percent)) throw new HwmonError('Consigne PWM invalide', 'INVALID');
    const p = this.paths(key);
    if (!this.allowWrites) throw new HwmonError('Écriture PWM désactivée (mode lecture seule)', 'NOT_WRITABLE');
    const output = this.getOutput(key);
    if (output && !output.writable) throw new HwmonError(`Sortie ${key} non inscriptible`, 'NOT_WRITABLE');
    const raw = percentToRaw(percent);
    try {
      writeFileSync(p.pwmPath, String(raw));
    } catch (err) {
      throw new HwmonError(`Écriture PWM refusée (${p.pwmPath}) : ${(err as Error).message}`, 'IO');
    }
  }

  readEnableMode(key: string): number | null {
    const p = this.paths(key);
    return p.enablePath ? readInt(p.enablePath) : null;
  }

  writeEnableMode(key: string, mode: number): void {
    const p = this.paths(key);
    if (!p.enablePath) throw new HwmonError(`Sortie ${key} sans pwm_enable : mode non modifiable`, 'UNSUPPORTED');
    if (!this.allowWrites) throw new HwmonError('Écriture désactivée (mode lecture seule)', 'NOT_WRITABLE');
    if (!Number.isInteger(mode) || mode < 0 || mode > 5) {
      throw new HwmonError(`Mode pwm_enable hors plage : ${mode}`, 'INVALID');
    }
    try {
      writeFileSync(p.enablePath, String(mode));
    } catch (err) {
      throw new HwmonError(`Changement de mode refusé (${p.enablePath}) : ${(err as Error).message}`, 'IO');
    }
  }

  readRpm(key: string): number | null {
    const p = this.paths(key);
    return p.tachPath ? readInt(p.tachPath) : null;
  }

  readRpmByTachKey(tachKey: string): number | null {
    const t = this.tachs.get(tachKey);
    return t ? readInt(t.path) : null;
  }

  tachKeysForController(ctrlKey: string): { key: string; index: number; path: string }[] {
    return [...this.tachs.values()]
      .filter((t) => t.controllerKey === ctrlKey)
      .map((t) => ({ key: t.key, index: t.index, path: t.path }));
  }

  readTempC(sensorKey: string): number | null {
    const path = this.tempPaths.get(sensorKey);
    if (!path) return null;
    const raw = readInt(path);
    return raw === null ? null : Math.round((raw / 1000) * 10) / 10;
  }

  bindTach(outputKey: string, tachKey: string | null): void {
    this.tachBindings.set(outputKey, tachKey);
    const p = this.outputPaths.get(outputKey);
    if (!p) return;
    const tach = tachKey ? this.tachs.get(tachKey) ?? null : null;
    p.tachKey = tach?.key ?? null;
    p.tachPath = tach?.path ?? null;
    const output = this.discovery.pwmOutputs.find((o) => o.key === outputKey);
    if (output) {
      output.tachPath = p.tachPath;
      output.tachIndex = tach?.index ?? null;
    }
  }

  /** Restaure les liaisons tachymétriques confirmées après un redécouverte. */
  restoreBindings(bindings: Map<string, string | null>): void {
    for (const [outputKey, tachKey] of bindings) this.bindTach(outputKey, tachKey);
  }
}

/** Informations BIOS / carte mère (DMI), utilisées pour invalider une calibration. */
export function readDmi(): { biosVersion: string | null; boardName: string | null; boardVendor: string | null } {
  const base = '/sys/class/dmi/id';
  return {
    biosVersion: readText(join(base, 'bios_version')),
    boardName: readText(join(base, 'board_name')),
    boardVendor: readText(join(base, 'board_vendor')),
  };
}

export { readText as readSysfsText, readInt as readSysfsInt, dirname as sysfsDirname };
