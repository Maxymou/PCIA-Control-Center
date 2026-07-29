/** Stockage NVMe : modèle, capacité, occupation, température, santé SMART.
 *
 *  Dégradation prévue : sans `nvme-cli` ni `smartctl`, on renvoie ce que
 *  /sys et statfs permettent (modèle, capacité, occupation) et `health` reste
 *  `null` — jamais une valeur inventée.
 */

import { statfs } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasTool, run } from '../system/exec.js';

export interface NvmeDevice {
  /** Nom du nœud (nvme0n1). */
  device: string;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  capacityGb: number | null;
  tempC: number | null;
  /** 100 − percentage_used, quand SMART est lisible. */
  healthPercent: number | null;
  smartOk: boolean | null;
  /** Nombre d'erreurs médias signalées. */
  mediaErrors: number | null;
  powerOnHours: number | null;
}

export interface StorageSummary {
  devices: NvmeDevice[];
  /** Périphérique principal retenu pour la vue du front-end. */
  primary: NvmeDevice | null;
  /** Occupation du système de fichiers racine. */
  rootCapacityGb: number | null;
  rootUsedGb: number | null;
  /** Activité disque en % (dérivée de /proc/diskstats). */
  activityPercent: number | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Contrôleurs NVMe exposés par le noyau — aucun chemin figé. */
function listNvmeNamespaces(): { controller: string; namespace: string }[] {
  const base = '/sys/class/nvme';
  if (!existsSync(base)) return [];
  const out: { controller: string; namespace: string }[] = [];
  for (const ctrl of readdirSync(base)) {
    const ctrlDir = join(base, ctrl);
    let entries: string[] = [];
    try {
      entries = readdirSync(ctrlDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/^nvme\d+n\d+$/.test(e)) out.push({ controller: ctrl, namespace: e });
    }
  }
  return out;
}

function sysfsDevice(controller: string, namespace: string): NvmeDevice {
  const ctrlDir = join('/sys/class/nvme', controller);
  const nsDir = join(ctrlDir, namespace);
  const sectors = readText(join('/sys/block', namespace, 'size'));
  const capacityGb = sectors
    ? Math.round((Number(sectors) * 512) / 1e9)
    : (() => {
      const s = readText(join(nsDir, 'size'));
      return s ? Math.round((Number(s) * 512) / 1e9) : null;
    })();
  return {
    device: namespace,
    model: readText(join(ctrlDir, 'model')),
    serial: readText(join(ctrlDir, 'serial')),
    firmware: readText(join(ctrlDir, 'firmware_rev')),
    capacityGb,
    tempC: null,
    healthPercent: null,
    smartOk: null,
    mediaErrors: null,
    powerOnHours: null,
  };
}

/** SMART via `nvme smart-log` (préféré) puis `smartctl`. */
async function enrichSmart(dev: NvmeDevice): Promise<void> {
  if (hasTool('nvme')) {
    const res = await run('nvme', ['smart-log', `/dev/${dev.device}`, '--output-format=json'], { timeoutMs: 6000 });
    if (res.ok) {
      try {
        const j = JSON.parse(res.stdout) as Record<string, number>;
        // La température est en kelvins dans le log SMART NVMe.
        if (typeof j.temperature === 'number') {
          dev.tempC = Math.round((j.temperature - 273.15) * 10) / 10;
        }
        if (typeof j.percent_used === 'number') dev.healthPercent = Math.max(0, 100 - j.percent_used);
        if (typeof j.critical_warning === 'number') dev.smartOk = j.critical_warning === 0;
        if (typeof j.media_errors === 'number') dev.mediaErrors = j.media_errors;
        if (typeof j.power_on_hours === 'number') dev.powerOnHours = j.power_on_hours;
        return;
      } catch {
        /* sortie non JSON : on tente smartctl */
      }
    }
  }
  if (hasTool('smartctl')) {
    const res = await run('smartctl', ['-j', '-a', `/dev/${dev.device}`], { timeoutMs: 8000 });
    if (!res.ok && !res.stdout) return;
    try {
      const j = JSON.parse(res.stdout) as Record<string, any>;
      dev.model ??= j.model_name ?? null;
      dev.serial ??= j.serial_number ?? null;
      if (j.temperature?.current !== undefined) dev.tempC = j.temperature.current;
      if (j.nvme_smart_health_information_log?.percentage_used !== undefined) {
        dev.healthPercent = Math.max(0, 100 - j.nvme_smart_health_information_log.percentage_used);
      }
      if (j.nvme_smart_health_information_log?.media_errors !== undefined) {
        dev.mediaErrors = j.nvme_smart_health_information_log.media_errors;
      }
      if (j.power_on_time?.hours !== undefined) dev.powerOnHours = j.power_on_time.hours;
      if (j.smart_status?.passed !== undefined) dev.smartOk = j.smart_status.passed;
    } catch {
      /* ignoré */
    }
  }
}

/** Activité disque dérivée de /proc/diskstats (temps passé en E/S). */
export class DiskActivityReader {
  private last = new Map<string, { ioMs: number; at: number }>();

  read(device: string): number | null {
    const raw = readText('/proc/diskstats');
    if (!raw) return null;
    const line = raw.split('\n').find((l) => l.trim().split(/\s+/)[2] === device);
    if (!line) return null;
    const fields = line.trim().split(/\s+/);
    // Champ 13 (index 12) : millisecondes passées en E/S.
    const ioMs = Number(fields[12]);
    if (!Number.isFinite(ioMs)) return null;
    const now = Date.now();
    const prev = this.last.get(device);
    this.last.set(device, { ioMs, at: now });
    if (!prev) return null;
    const dt = now - prev.at;
    if (dt <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(((ioMs - prev.ioMs) / dt) * 100)));
  }
}

const activityReader = new DiskActivityReader();

export async function readStorage(): Promise<StorageSummary> {
  const namespaces = listNvmeNamespaces();
  const devices = namespaces.map((n) => sysfsDevice(n.controller, n.namespace));
  await Promise.all(devices.map(enrichSmart));

  // Le périphérique principal est le plus grand — c'est celui qu'affiche l'UI.
  const primary = devices.length
    ? devices.reduce((a, b) => ((b.capacityGb ?? 0) > (a.capacityGb ?? 0) ? b : a))
    : null;

  let rootCapacityGb: number | null = null;
  let rootUsedGb: number | null = null;
  try {
    const fs = await statfs('/');
    const total = Number(fs.blocks) * Number(fs.bsize);
    const free = Number(fs.bavail) * Number(fs.bsize);
    rootCapacityGb = Math.round(total / 1e9);
    rootUsedGb = Math.round((total - free) / 1e9);
  } catch {
    /* statfs indisponible */
  }

  return {
    devices,
    primary,
    rootCapacityGb,
    rootUsedGb,
    activityPercent: primary ? activityReader.read(primary.device) : null,
  };
}
