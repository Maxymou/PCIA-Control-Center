/** Inventaire matériel : construit les `HardwareItem[]` attendus par le front-end.
 *
 *  Points d'attention :
 *   - un GPU est identifié par **UUID** (et adresse PCI en second) ; l'ordre
 *     `GPU 0/1/2` n'est jamais utilisé comme identité ;
 *   - l'association GPU → emplacement logique (`v100-1`, `v100-2`, `gtx1080`)
 *     est persistée : elle survit aux redémarrages et aux permutations ;
 *   - la GTX 1080 n'est renvoyée `installed: true` que si elle est réellement
 *     détectée ;
 *   - aucune donnée n'est inventée : ce qui n'est pas mesurable reste absent.
 */

import type {
  Capabilities, DiscoveredTempSensor, HardwareId, HardwareItem, HardwareMetrics, Severity,
} from '../contract.js';
import type { AppConfig } from '../config.js';
import type { SettingsRepo } from '../db/repositories.js';
import type { HwmonBackend } from '../hwmon/backend.js';
import { createLogger } from '../logger.js';
import { hasTool, KNOWN_TOOLS } from '../system/exec.js';
import { boardLabel, readSystemInfo } from '../system/info.js';
import { CpuReader, readMemory, type CpuInfo, type MemoryInfo } from './cpu.js';
import { classifyGpu, readGpus, type GpuInfo } from './gpu.js';
import { annotateSensors, resolveSensorMap } from './sensors.js';
import { readStorage, type StorageSummary } from './storage.js';

const log = createLogger('hardware.inventory');

export const GPU_SLOTS: HardwareId[] = ['v100-1', 'v100-2', 'gtx1080'];

const SLOT_NAMES: Record<string, string> = {
  cpu: 'CPU',
  nvme: 'SSD NVMe',
  'v100-1': 'Tesla V100 n°1',
  'v100-2': 'Tesla V100 n°2',
  gtx1080: 'GTX 1080',
  'case-front': 'Boîtier avant',
  'case-rear': 'Boîtier arrière',
  motherboard: 'Carte mère',
};

interface GpuSlotBinding {
  uuid: string;
  pciBusId: string;
  name: string;
}

const SETTINGS_GPU_SLOTS = 'gpuSlots';
const SETTINGS_SENSOR_OVERRIDES = 'sensorOverrides';

export interface InventoryDeps {
  hwmon: HwmonBackend;
  settings: SettingsRepo;
  config: AppConfig;
  /** Mode démo : les GPU sont fournis par le simulateur. */
  gpuProvider?: () => Promise<{ gpus: GpuInfo[]; available: boolean; error?: string }>;
  /** Mode démo : le stockage est fourni par le simulateur. */
  storageProvider?: () => Promise<StorageSummary>;
}

export interface InventoryState {
  items: HardwareItem[];
  temps: Partial<Record<HardwareId, number>>;
  gpus: GpuInfo[];
  cpu: CpuInfo | null;
  memory: MemoryInfo | null;
  storage: StorageSummary | null;
  sensorMap: Partial<Record<HardwareId, string>>;
  annotatedSensors: DiscoveredTempSensor[];
  warnings: string[];
  /** Emplacements GPU apparus / disparus depuis le dernier inventaire. */
  changes: { appeared: HardwareId[]; disappeared: HardwareId[] };
}

export class HardwareInventory {
  private cpuReader = new CpuReader();
  private gpus: GpuInfo[] = [];
  private gpuAvailable = false;
  private gpuError: string | undefined;
  private storage: StorageSummary | null = null;
  private cpu: CpuInfo | null = null;
  private memory: MemoryInfo | null = null;
  private sensorMap: Partial<Record<HardwareId, string>> = {};
  private sensorWarnings: string[] = [];
  private lastInstalled = new Set<HardwareId>();

  constructor(private deps: InventoryDeps) {}

  /** Association GPU → emplacement, persistée. */
  private slotBindings(): Partial<Record<HardwareId, GpuSlotBinding>> {
    return this.deps.settings.get<Partial<Record<HardwareId, GpuSlotBinding>>>(SETTINGS_GPU_SLOTS, {});
  }

  /** Attribue les emplacements aux GPU détectés. Stable dans le temps. */
  private assignGpuSlots(gpus: GpuInfo[]): { map: Map<HardwareId, GpuInfo>; unassigned: GpuInfo[] } {
    const bindings = this.slotBindings();
    const map = new Map<HardwareId, GpuInfo>();
    const taken = new Set<HardwareId>();
    const remaining = [...gpus].sort((a, b) => a.pciBusId.localeCompare(b.pciBusId));

    // 1. Réutiliser les liaisons existantes (par UUID, puis par adresse PCI).
    for (const slot of GPU_SLOTS) {
      const binding = bindings[slot];
      if (!binding) continue;
      let idx = remaining.findIndex((g) => g.uuid === binding.uuid);
      if (idx < 0) idx = remaining.findIndex((g) => g.pciBusId === binding.pciBusId && classifyGpu(g.name) === classifyGpu(binding.name));
      if (idx >= 0) {
        map.set(slot, remaining[idx]);
        taken.add(slot);
        remaining.splice(idx, 1);
      }
    }

    // 2. Attribuer les GPU restants selon leur modèle.
    const nextBindings: Partial<Record<HardwareId, GpuSlotBinding>> = { ...bindings };
    for (const gpu of [...remaining]) {
      const kind = classifyGpu(gpu.name);
      const candidates = kind === 'geforce'
        ? (['gtx1080'] as HardwareId[])
        : kind === 'v100'
          ? (['v100-1', 'v100-2'] as HardwareId[])
          : (['v100-1', 'v100-2', 'gtx1080'] as HardwareId[]);
      const slot = candidates.find((s) => !taken.has(s));
      if (!slot) {
        log.throttled(`no-slot-${gpu.uuid}`, 600_000, 'warn',
          'GPU détecté sans emplacement disponible dans l’interface', { name: gpu.name, pci: gpu.pciBusId });
        continue;
      }
      map.set(slot, gpu);
      taken.add(slot);
      nextBindings[slot] = { uuid: gpu.uuid, pciBusId: gpu.pciBusId, name: gpu.name };
      remaining.splice(remaining.indexOf(gpu), 1);
      log.info('GPU rattaché à un emplacement', { slot, name: gpu.name, uuid: gpu.uuid, pci: gpu.pciBusId });
    }

    if (JSON.stringify(nextBindings) !== JSON.stringify(bindings)) {
      this.deps.settings.set(SETTINGS_GPU_SLOTS, nextBindings);
    }
    return { map, unassigned: remaining };
  }

  /** Inventaire complet : GPU, stockage, association des capteurs. */
  async refreshStatic(): Promise<void> {
    const gpuRead = this.deps.gpuProvider ? await this.deps.gpuProvider() : await readGpus();
    this.gpus = gpuRead.gpus;
    this.gpuAvailable = gpuRead.available;
    this.gpuError = gpuRead.error;

    try {
      this.storage = this.deps.storageProvider ? await this.deps.storageProvider() : await readStorage();
    } catch (err) {
      log.warn('Lecture du stockage impossible', { error: err });
      this.storage = null;
    }

    this.refreshSensorMap();
  }

  refreshSensorMap(): void {
    const sensors = this.deps.hwmon.cached().tempSensors;
    const overrides = this.deps.settings.get<Partial<Record<HardwareId, string>>>(SETTINGS_SENSOR_OVERRIDES, {});
    const resolved = resolveSensorMap(sensors, overrides);
    this.sensorMap = resolved.map;
    this.sensorWarnings = resolved.warnings;
  }

  /** Force l'association d'un capteur à un emplacement. */
  setSensorOverride(target: HardwareId, sensorKey: string | null): void {
    const overrides = this.deps.settings.get<Partial<Record<HardwareId, string>>>(SETTINGS_SENSOR_OVERRIDES, {});
    if (sensorKey) overrides[target] = sensorKey;
    else delete overrides[target];
    this.deps.settings.set(SETTINGS_SENSOR_OVERRIDES, overrides);
    this.refreshSensorMap();
  }

  /** Échantillonnage rapide : CPU, mémoire, températures hwmon. */
  sampleFast(): void {
    this.cpu = this.cpuReader.read();
    this.memory = readMemory();
  }

  /** Rafraîchit uniquement les mesures GPU (plus coûteux : cadence dédiée). */
  async sampleGpus(): Promise<void> {
    const read = this.deps.gpuProvider ? await this.deps.gpuProvider() : await readGpus();
    this.gpuAvailable = read.available;
    this.gpuError = read.error;
    if (read.available) this.gpus = read.gpus;
  }

  async sampleStorage(): Promise<void> {
    try {
      this.storage = this.deps.storageProvider ? await this.deps.storageProvider() : await readStorage();
    } catch (err) {
      log.throttled('storage-fail', 300_000, 'warn', 'Lecture du stockage en échec', { error: err });
    }
  }

  /** Températures par emplacement logique, capteurs hwmon + GPU. */
  temperatures(): Partial<Record<HardwareId, number>> {
    const out: Partial<Record<HardwareId, number>> = {};
    for (const [target, key] of Object.entries(this.sensorMap) as [HardwareId, string][]) {
      const value = this.deps.hwmon.readTempC(key);
      if (value !== null && Number.isFinite(value)) out[target] = value;
    }
    const { map } = this.assignGpuSlots(this.gpus);
    for (const [slot, gpu] of map) {
      if (gpu.tempC !== null) out[slot] = gpu.tempC;
    }
    // Le NVMe expose sa température via SMART si aucun hwmon ne le fait.
    if (out.nvme === undefined && this.storage?.primary?.tempC != null) {
      out.nvme = this.storage.primary.tempC;
    }
    return out;
  }

  private severityFor(id: HardwareId, temp: number | undefined): Severity {
    if (temp === undefined) return 'unknown';
    const thresholds = this.deps.config.alerts.temperatureThresholds[id];
    if (!thresholds) return 'normal';
    if (temp >= thresholds[1]) return 'critical';
    if (temp >= thresholds[0]) return 'warning';
    return 'normal';
  }

  /** Construit la liste attendue par le front-end. */
  build(): InventoryState {
    const temps = this.temperatures();
    const { map: gpuMap, unassigned } = this.assignGpuSlots(this.gpus);
    const sysInfo = readSystemInfo();
    const items: HardwareItem[] = [];
    const warnings: string[] = [...this.sensorWarnings];

    // --- CPU ---
    const cpuMetrics: HardwareMetrics = { status: this.severityFor('cpu', temps.cpu) };
    if (temps.cpu !== undefined) cpuMetrics.temp = temps.cpu;
    if (this.cpu?.load != null) cpuMetrics.load = this.cpu.load;
    if (this.cpu?.freqMhz != null) cpuMetrics.freq = this.cpu.freqMhz;
    if (this.cpu?.powerW != null) cpuMetrics.power = this.cpu.powerW;
    if (this.memory) {
      // La mémoire système est présentée avec le CPU (le front n'a pas de carte dédiée).
      cpuMetrics.memUsed = this.memory.usedGb;
      cpuMetrics.memTotal = this.memory.totalGb;
    }
    items.push({
      id: 'cpu',
      name: SLOT_NAMES.cpu,
      kind: 'cpu',
      model: this.cpu ? `${this.cpu.model}${this.cpu.cores ? ` (${this.cpu.cores}c/${this.cpu.threads}t)` : ''}` : undefined,
      installed: true,
      metrics: cpuMetrics,
    });

    // --- NVMe ---
    const primary = this.storage?.primary ?? null;
    const nvmeMetrics: HardwareMetrics = { status: this.severityFor('nvme', temps.nvme) };
    if (temps.nvme !== undefined) nvmeMetrics.temp = temps.nvme;
    if (primary?.capacityGb != null) nvmeMetrics.capacity = primary.capacityGb;
    if (this.storage?.rootUsedGb != null) nvmeMetrics.used = this.storage.rootUsedGb;
    if (primary?.healthPercent != null) nvmeMetrics.health = primary.healthPercent;
    if (this.storage?.activityPercent != null) nvmeMetrics.activity = this.storage.activityPercent;
    if (primary?.smartOk === false) {
      nvmeMetrics.status = 'critical';
    }
    items.push({
      id: 'nvme',
      name: SLOT_NAMES.nvme,
      kind: 'storage',
      model: primary?.model ?? undefined,
      installed: primary !== null,
      metrics: nvmeMetrics,
    });

    // --- GPU ---
    for (const slot of GPU_SLOTS) {
      const gpu = gpuMap.get(slot);
      const metrics: HardwareMetrics = { status: gpu ? this.severityFor(slot, temps[slot]) : 'unknown' };
      if (gpu) {
        if (gpu.tempC !== null) metrics.temp = gpu.tempC;
        if (gpu.utilizationPercent !== null) metrics.load = gpu.utilizationPercent;
        if (gpu.memoryUsedGb !== null) metrics.memUsed = gpu.memoryUsedGb;
        if (gpu.memoryTotalGb !== null) metrics.memTotal = gpu.memoryTotalGb;
        if (gpu.powerW !== null) metrics.power = gpu.powerW;
      }
      items.push({
        id: slot,
        name: gpu ? (slot === 'gtx1080' ? SLOT_NAMES.gtx1080 : SLOT_NAMES[slot]) : SLOT_NAMES[slot],
        kind: 'gpu',
        model: gpu?.name,
        // La GTX 1080 (comme toute carte) n'est « installée » que si elle est vue.
        installed: gpu !== undefined,
        pcieSlot: gpu?.pcieSlot,
        metrics,
      });
    }

    // --- Boîtier : uniquement si un capteur y est réellement associé ---
    for (const slot of ['case-front', 'case-rear'] as HardwareId[]) {
      const temp = temps[slot];
      items.push({
        id: slot,
        name: SLOT_NAMES[slot],
        kind: 'case',
        installed: temp !== undefined,
        metrics: temp !== undefined
          ? { temp, status: this.severityFor(slot, temp) }
          : { status: 'unknown' },
      });
    }

    // --- Carte mère ---
    items.push({
      id: 'motherboard',
      name: SLOT_NAMES.motherboard,
      kind: 'board',
      model: boardLabel(sysInfo) ?? undefined,
      installed: true,
      metrics: temps.motherboard !== undefined
        ? { temp: temps.motherboard, status: this.severityFor('motherboard', temps.motherboard) }
        : { status: 'unknown' },
    });

    if (!this.gpuAvailable && this.gpuError) {
      warnings.push(`GPU NVIDIA non interrogeables : ${this.gpuError}`);
    }
    for (const g of unassigned) {
      warnings.push(`GPU détecté sans emplacement dans l’interface : ${g.name} (${g.pciBusId}).`);
    }

    // --- Apparitions / disparitions ---
    const installed = new Set(items.filter((i) => i.installed).map((i) => i.id));
    const appeared = [...installed].filter((id) => this.lastInstalled.size > 0 && !this.lastInstalled.has(id));
    const disappeared = [...this.lastInstalled].filter((id) => !installed.has(id));
    this.lastInstalled = installed;

    return {
      items,
      temps,
      gpus: this.gpus,
      cpu: this.cpu,
      memory: this.memory,
      storage: this.storage,
      sensorMap: this.sensorMap,
      annotatedSensors: annotateSensors(this.deps.hwmon.cached().tempSensors, this.sensorMap),
      warnings,
      changes: { appeared, disappeared },
    };
  }

  /** Capacités réellement disponibles — le front-end désactive le reste. */
  capabilities(extra: { canReturnToBios: boolean; canControlFans: boolean }): Capabilities {
    const discovery = this.deps.hwmon.cached();
    const tools = Object.fromEntries(KNOWN_TOOLS.map((t) => [t, hasTool(t)]));
    if (this.deps.hwmon.kind === 'simulated') {
      // En mode démo, les outils réels ne sont pas requis.
      for (const t of ['nvidia-smi', 'systemctl', 'docker', 'ss']) tools[t] = true;
    }
    return {
      canReadTemperature: discovery.tempSensors.length > 0 || this.gpus.length > 0,
      canReadRpm: discovery.pwmOutputs.some((o) => o.tachPath !== null) || discovery.orphanTachs.length > 0,
      canWritePwm: discovery.pwmOutputs.some((o) => o.writable),
      canReturnToBios: extra.canReturnToBios,
      canDetectServices: Boolean(tools.systemctl || tools.docker) || this.deps.hwmon.kind === 'simulated',
      canDetectConnections: Boolean(tools.ss) || this.deps.hwmon.kind === 'simulated',
      canReadGpuPower: this.gpus.some((g) => g.powerW !== null),
      canReadStorageSmart: Boolean(this.storage?.primary?.healthPercent != null),
      canControlFans: extra.canControlFans,
      tools,
    };
  }

  gpuList(): GpuInfo[] {
    return this.gpus;
  }

  storageSummary(): StorageSummary | null {
    return this.storage;
  }
}
