/** Source de températures du moteur de ventilation.
 *
 *  Volontairement **autonome** : le moteur ne doit dépendre ni de l'API, ni du
 *  collecteur de métriques. Il lit lui-même les capteurs hwmon et interroge
 *  nvidia-smi à une cadence plus lente (commande coûteuse).
 *
 *  Une lecture indisponible remonte `null` — jamais une valeur périmée déguisée
 *  en mesure fraîche : c'est ce qui déclenche les sécurités.
 */

import type { HardwareId, SensorRef } from '../contract.js';
import { createLogger } from '../logger.js';
import type { HwmonBackend } from '../hwmon/backend.js';
import { resolveSensorMap } from '../hardware/sensors.js';
import { readGpus, type GpuInfo } from '../hardware/gpu.js';

const log = createLogger('fan.sensors');

export interface SensorReading {
  value: number | null;
  /** Horodatage de la dernière mesure valide. */
  at: number | null;
}

export interface SensorSourceOptions {
  hwmon: HwmonBackend;
  /** Forçages capteur → emplacement, relus depuis la base. */
  overrides: () => Partial<Record<HardwareId, string>>;
  /** Association emplacement → { uuid, pciBusId }, relue depuis la base. */
  gpuSlots: () => Partial<Record<HardwareId, { uuid: string; pciBusId: string }>>;
  /** Intervalle d'interrogation des GPU. */
  gpuIntervalMs?: number;
  /** Injection pour le mode démo / les tests. */
  gpuProvider?: () => Promise<{ gpus: GpuInfo[]; available: boolean }>;
}

export class SensorSource {
  private map: Partial<Record<HardwareId, string>> = {};
  private gpuTemps: Partial<Record<HardwareId, SensorReading>> = {};
  private lastGpuPoll = 0;
  private gpuPolling = false;

  constructor(private opts: SensorSourceOptions) {
    this.refreshMap();
  }

  /** Recalcule l'association capteur → emplacement après une (re)découverte. */
  refreshMap(): void {
    const sensors = this.opts.hwmon.cached().tempSensors;
    const resolved = resolveSensorMap(sensors, this.opts.overrides());
    this.map = resolved.map;
    for (const w of resolved.warnings) log.throttled(w, 600_000, 'warn', w);
  }

  /** Interroge les GPU si la cadence le permet. Non bloquant. */
  pollGpus(now = Date.now()): void {
    const interval = this.opts.gpuIntervalMs ?? 3000;
    if (this.gpuPolling || now - this.lastGpuPoll < interval) return;
    this.gpuPolling = true;
    this.lastGpuPoll = now;
    const read = this.opts.gpuProvider ? this.opts.gpuProvider() : readGpus();
    read.then((res) => {
      if (!res.available) {
        // Les GPU deviennent illisibles : les lectures vieillissent et les
        // sécurités s'en chargeront. On ne fabrique pas de valeur.
        return;
      }
      const slots = this.opts.gpuSlots();
      const next: Partial<Record<HardwareId, SensorReading>> = {};
      for (const [slot, binding] of Object.entries(slots) as [HardwareId, { uuid: string; pciBusId: string }][]) {
        const gpu = res.gpus.find((g) => g.uuid === binding.uuid)
          ?? res.gpus.find((g) => g.pciBusId === binding.pciBusId);
        if (gpu && gpu.tempC !== null) next[slot] = { value: gpu.tempC, at: Date.now() };
      }
      this.gpuTemps = next;
    }).catch((err) => {
      log.throttled('gpu-poll', 300_000, 'warn', 'Lecture GPU en échec', { error: err });
    }).finally(() => {
      this.gpuPolling = false;
    });
  }

  /** Température d'un emplacement, ou `null` si la mesure est indisponible. */
  read(id: HardwareId): number | null {
    const gpu = this.gpuTemps[id];
    if (gpu) {
      // Une lecture GPU trop ancienne n'est plus une mesure.
      const maxAge = (this.opts.gpuIntervalMs ?? 3000) * 4;
      if (gpu.at !== null && Date.now() - gpu.at <= maxAge) return gpu.value;
      return null;
    }
    const key = this.map[id];
    if (!key) return null;
    const value = this.opts.hwmon.readTempC(key);
    return value !== null && Number.isFinite(value) ? value : null;
  }

  /** Toutes les températures disponibles. */
  all(): Partial<Record<HardwareId, number>> {
    const out: Partial<Record<HardwareId, number>> = {};
    for (const id of Object.keys(this.map) as HardwareId[]) {
      const v = this.read(id);
      if (v !== null) out[id] = v;
    }
    for (const id of Object.keys(this.gpuTemps) as HardwareId[]) {
      const v = this.read(id);
      if (v !== null) out[id] = v;
    }
    return out;
  }

  /** Emplacements GPU actuellement lisibles. */
  availableGpus(): HardwareId[] {
    return (Object.keys(this.gpuTemps) as HardwareId[]).filter((id) => this.read(id) !== null);
  }
}

/** Calcule la température de référence d'une sortie à partir de sa définition.
 *
 *  Renvoie `null` si aucun capteur de la sélection n'est lisible : c'est la
 *  condition qui déclenche la vitesse de secours. */
export function resolveRefTemp(
  sensor: SensorRef,
  source: { read(id: HardwareId): number | null; availableGpus(): HardwareId[] },
): { value: number | null; missing: HardwareId[] } {
  switch (sensor.kind) {
    case 'single': {
      const v = source.read(sensor.source);
      return { value: v, missing: v === null ? [sensor.source] : [] };
    }
    case 'hottest-gpu': {
      const gpus = source.availableGpus();
      const values = gpus.map((g) => source.read(g)).filter((v): v is number => v !== null);
      return { value: values.length ? Math.max(...values) : null, missing: values.length ? [] : gpus };
    }
    case 'max': {
      const missing: HardwareId[] = [];
      const values: number[] = [];
      for (const s of sensor.sources) {
        const v = source.read(s);
        if (v === null) missing.push(s);
        else values.push(v);
      }
      return { value: values.length ? Math.max(...values) : null, missing };
    }
    case 'avg': {
      const missing: HardwareId[] = [];
      const values: number[] = [];
      for (const s of sensor.sources) {
        const v = source.read(s);
        if (v === null) missing.push(s);
        else values.push(v);
      }
      return {
        value: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null,
        missing,
      };
    }
  }
}
