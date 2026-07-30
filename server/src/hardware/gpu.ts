/** GPU NVIDIA.
 *
 *  Identification **stable par UUID**, avec l'adresse PCI comme second
 *  identifiant : l'ordre `GPU 0 / GPU 1` change après un redémarrage et ne doit
 *  jamais servir d'identité. Le rattachement d'un GPU à un emplacement logique
 *  du front-end (`v100-1`, `v100-2`, `gtx1080`) est persisté en base.
 */

import { numOrNull, parseCsvLine, run } from '../system/exec.js';
import { createLogger } from '../logger.js';

const log = createLogger('hardware.gpu');

export interface GpuProcess {
  pid: number;
  name: string;
  usedMemoryMb: number | null;
}

export interface GpuInfo {
  /** Identifiant stable, forme `GPU-xxxxxxxx-...`. */
  uuid: string;
  name: string;
  /** Adresse PCI complète (ex. 00000000:17:00.0). */
  pciBusId: string;
  /** Emplacement lisible (ex. « PCIe 17:00 »). */
  pcieSlot: string;
  tempC: number | null;
  utilizationPercent: number | null;
  memoryUsedGb: number | null;
  memoryTotalGb: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  driverVersion: string | null;
  cudaVersion: string | null;
  /** État rapporté par le pilote (`Active`, ou message d'erreur). */
  state: string;
  processes: GpuProcess[];
}

const QUERY_FIELDS = [
  'uuid', 'name', 'pci.bus_id', 'temperature.gpu', 'utilization.gpu',
  'memory.used', 'memory.total', 'power.draw', 'power.limit', 'driver_version',
];

let cudaVersionCache: string | null | undefined = undefined;

/** Version CUDA annoncée par le pilote — lue une seule fois. */
async function readCudaVersion(): Promise<string | null> {
  if (cudaVersionCache !== undefined) return cudaVersionCache;
  const res = await run('nvidia-smi', ['--query', '--display=COMPUTE'], { timeoutMs: 8000 });
  let version: string | null = null;
  if (res.ok) {
    version = /CUDA Version\s*:\s*([\d.]+)/i.exec(res.stdout)?.[1] ?? null;
  }
  if (!version) {
    const plain = await run('nvidia-smi', [], { timeoutMs: 8000 });
    if (plain.ok) version = /CUDA Version:\s*([\d.]+)/i.exec(plain.stdout)?.[1] ?? null;
  }
  cudaVersionCache = version;
  return version;
}

async function readProcesses(): Promise<Map<string, GpuProcess[]>> {
  const byUuid = new Map<string, GpuProcess[]>();
  const res = await run('nvidia-smi', [
    '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
    '--format=csv,noheader,nounits',
  ], { timeoutMs: 5000 });
  if (!res.ok) return byUuid;
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [uuid, pid, name, mem] = parseCsvLine(line);
    if (!uuid) continue;
    const list = byUuid.get(uuid) ?? [];
    list.push({ pid: Number(pid) || 0, name: name ?? 'inconnu', usedMemoryMb: numOrNull(mem) });
    byUuid.set(uuid, list);
  }
  return byUuid;
}

/** Formatte `00000000:17:00.0` en `PCIe 17:00`. */
function formatSlot(busId: string): string {
  const m = /:?([0-9a-f]{2}):([0-9a-f]{2})\.\d$/i.exec(busId);
  return m ? `PCIe ${m[1]}:${m[2]}` : busId;
}

/** Interroge nvidia-smi. Renvoie une liste vide si l'outil est absent —
 *  ce n'est pas une erreur : la machine peut ne pas avoir de GPU NVIDIA. */
export async function readGpus(): Promise<{ gpus: GpuInfo[]; available: boolean; error?: string }> {
  const res = await run('nvidia-smi', [
    `--query-gpu=${QUERY_FIELDS.join(',')}`,
    '--format=csv,noheader,nounits',
  ], { timeoutMs: 8000 });

  if (!res.ok) {
    return { gpus: [], available: false, error: res.error ?? 'nvidia-smi indisponible' };
  }

  const [cuda, processes] = await Promise.all([readCudaVersion(), readProcesses()]);
  const gpus: GpuInfo[] = [];

  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < QUERY_FIELDS.length) {
      log.throttled('short-line', 300_000, 'warn', 'Ligne nvidia-smi incomplète', { line });
      continue;
    }
    const [uuid, name, busId, temp, util, memUsed, memTotal, power, powerLimit, driver] = cols;
    if (!uuid || !uuid.startsWith('GPU-')) {
      log.throttled('bad-uuid', 300_000, 'warn', 'UUID GPU inattendu — GPU ignoré', { uuid });
      continue;
    }
    const memUsedMb = numOrNull(memUsed);
    const memTotalMb = numOrNull(memTotal);
    gpus.push({
      uuid,
      name,
      pciBusId: busId,
      pcieSlot: formatSlot(busId),
      tempC: numOrNull(temp),
      utilizationPercent: numOrNull(util),
      memoryUsedGb: memUsedMb === null ? null : Math.round((memUsedMb / 1024) * 10) / 10,
      memoryTotalGb: memTotalMb === null ? null : Math.round(memTotalMb / 1024),
      powerW: numOrNull(power),
      powerLimitW: numOrNull(powerLimit),
      driverVersion: driver || null,
      cudaVersion: cuda,
      state: 'Active',
      processes: processes.get(uuid) ?? [],
    });
  }

  return { gpus, available: true };
}

/** Classement du modèle, utilisé pour l'attribution initiale des emplacements. */
export function classifyGpu(name: string): 'v100' | 'geforce' | 'other' {
  if (/tesla|v100/i.test(name)) return 'v100';
  if (/geforce|gtx|rtx/i.test(name)) return 'geforce';
  return 'other';
}
