/** Processeur : modèle, charge, fréquence, cœurs, consommation.
 *
 *  Sources : /proc/cpuinfo, /proc/stat, /sys/devices/system/cpu, RAPL
 *  (/sys/class/powercap). Toutes optionnelles : ce qui manque est renvoyé à
 *  `null` plutôt que deviné.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

export interface CpuInfo {
  model: string;
  cores: number | null;
  threads: number;
  /** Charge globale en %, calculée entre deux lectures de /proc/stat. */
  load: number | null;
  /** Fréquence moyenne en MHz. */
  freqMhz: number | null;
  /** Consommation paquet en W (RAPL), null si non exposée. */
  powerW: number | null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function cpuModel(): string {
  const info = readText('/proc/cpuinfo');
  if (info) {
    const m = /^model name\s*:\s*(.+)$/m.exec(info);
    if (m) return m[1].trim();
  }
  const list = cpus();
  return list.length > 0 ? list[0].model : 'Processeur inconnu';
}

function physicalCores(): number | null {
  const info = readText('/proc/cpuinfo');
  if (!info) return null;
  // Un couple (physical id, core id) par cœur physique.
  const blocks = info.split('\n\n');
  const set = new Set<string>();
  for (const block of blocks) {
    const phys = /^physical id\s*:\s*(\d+)$/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)$/m.exec(block)?.[1];
    if (phys !== undefined && core !== undefined) set.add(`${phys}:${core}`);
  }
  if (set.size > 0) return set.size;
  const cpuCores = /^cpu cores\s*:\s*(\d+)$/m.exec(info)?.[1];
  return cpuCores ? Number(cpuCores) : null;
}

interface StatSample { idle: number; total: number; }

function readStat(): StatSample | null {
  const stat = readText('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (parts.length < 5) return null;
  const idle = parts[3] + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function averageFreqMhz(): number | null {
  // Fréquence courante par cœur, quand le pilote cpufreq l'expose.
  const base = '/sys/devices/system/cpu';
  try {
    const dirs = readdirSync(base).filter((d) => /^cpu\d+$/.test(d));
    const values: number[] = [];
    for (const d of dirs) {
      const p = join(base, d, 'cpufreq', 'scaling_cur_freq');
      const raw = readText(p);
      if (raw) {
        const khz = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(khz)) values.push(khz / 1000);
      }
    }
    if (values.length > 0) return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  } catch {
    /* cpufreq absent */
  }
  // Repli : /proc/cpuinfo « cpu MHz ».
  const info = readText('/proc/cpuinfo');
  if (info) {
    const values = [...info.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)].map((m) => Number(m[1]));
    if (values.length > 0) return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }
  const list = cpus();
  return list.length > 0 && list[0].speed > 0 ? list[0].speed : null;
}

/** Compteur RAPL : énergie cumulée en microjoules, à dériver dans le temps. */
function raplEnergyUj(): { uj: number; maxUj: number } | null {
  const base = '/sys/class/powercap';
  if (!existsSync(base)) return null;
  try {
    // On additionne les domaines « package-N » de premier niveau.
    const zones = readdirSync(base).filter((d) => /^intel-rapl:\d+$/.test(d));
    let total = 0;
    let max = 0;
    let found = false;
    for (const z of zones) {
      const name = readText(join(base, z, 'name'))?.trim() ?? '';
      if (!name.startsWith('package')) continue;
      const raw = readText(join(base, z, 'energy_uj'));
      const rangeRaw = readText(join(base, z, 'max_energy_range_uj'));
      if (raw) {
        const v = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(v)) {
          total += v;
          found = true;
        }
      }
      if (rangeRaw) {
        const v = Number.parseInt(rangeRaw.trim(), 10);
        if (Number.isFinite(v)) max += v;
      }
    }
    return found ? { uj: total, maxUj: max } : null;
  } catch {
    return null;
  }
}

/** Lecture CPU avec état interne (deltas /proc/stat et RAPL). */
export class CpuReader {
  private lastStat: StatSample | null = null;
  private lastRapl: { uj: number; maxUj: number; at: number } | null = null;
  private cachedModel: string | null = null;
  private cachedCores: number | null | undefined = undefined;

  /** Vrai si la consommation CPU est mesurable sur cette machine. */
  static hasPowerReadings(): boolean {
    return raplEnergyUj() !== null;
  }

  read(): CpuInfo {
    if (this.cachedModel === null) this.cachedModel = cpuModel();
    if (this.cachedCores === undefined) this.cachedCores = physicalCores();

    let load: number | null = null;
    const sample = readStat();
    if (sample && this.lastStat) {
      const dTotal = sample.total - this.lastStat.total;
      const dIdle = sample.idle - this.lastStat.idle;
      if (dTotal > 0) load = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
    }
    if (sample) this.lastStat = sample;

    let powerW: number | null = null;
    const rapl = raplEnergyUj();
    const now = Date.now();
    if (rapl && this.lastRapl) {
      const dt = (now - this.lastRapl.at) / 1000;
      let dUj = rapl.uj - this.lastRapl.uj;
      // Le compteur boucle : on corrige avec la plage maximale.
      if (dUj < 0 && rapl.maxUj > 0) dUj += rapl.maxUj;
      if (dt > 0.2 && dUj >= 0) {
        const w = dUj / 1e6 / dt;
        // Une valeur aberrante (> 2 kW) signale un compteur incohérent.
        powerW = w > 0 && w < 2000 ? Math.round(w) : null;
      }
    }
    if (rapl) this.lastRapl = { ...rapl, at: now };

    return {
      model: this.cachedModel,
      cores: this.cachedCores ?? null,
      threads: cpus().length,
      load,
      freqMhz: averageFreqMhz(),
      powerW,
    };
  }
}

export interface MemoryInfo {
  totalGb: number;
  usedGb: number;
  availableGb: number;
  usedPercent: number;
}

export function readMemory(): MemoryInfo | null {
  const raw = readText('/proc/meminfo');
  if (!raw) return null;
  const get = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(raw);
    return m ? Number(m[1]) : null;
  };
  const totalKb = get('MemTotal');
  const availKb = get('MemAvailable') ?? get('MemFree');
  if (totalKb === null || availKb === null) return null;
  const toGb = (kb: number) => Math.round((kb / 1024 / 1024) * 10) / 10;
  const total = toGb(totalKb);
  const available = toGb(availKb);
  const used = Math.round((total - available) * 10) / 10;
  return {
    totalGb: total,
    usedGb: used,
    availableGb: available,
    usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}
