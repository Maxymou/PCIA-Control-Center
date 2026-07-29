/** Contrôleurs hwmon simulés.
 *
 *  Sert deux usages :
 *   - le **mode démonstration** (machine sans accès hwmon, poste de dev) ;
 *   - les **tests automatisés**, qui doivent pouvoir reproduire panne capteur,
 *     écriture refusée, ventilateur bloqué, retour BIOS, changement d'index
 *     hwmon, disparition d'une sortie ou remplacement d'un contrôleur —
 *     sans jamais toucher à du matériel réel.
 *
 *  La physique est volontairement simple mais cohérente : le RPM suit la
 *  consigne avec une inertie, ne démarre qu'au-dessus d'un seuil, et retombe
 *  à zéro si la consigne passe sous le seuil de maintien.
 */

import type {
  ControllerIdentity, DiscoveredPwmOutput, DiscoveredTempSensor, HwmonDiscovery,
} from '../contract.js';
import { emptyDiscovery, HwmonBackend, HwmonError } from './backend.js';

/** Modes pwmN_enable simulés, calqués sur les conventions nct6775. */
export const SIM_MODE_FULL = 0;
export const SIM_MODE_MANUAL = 1;
export const SIM_MODE_BIOS = 5;

interface SimFan {
  index: number;
  label: string;
  maxRpm: number;
  /** Consigne minimale pour démarrer depuis l'arrêt (%). */
  startupPwm: number;
  /** Consigne minimale pour rester en rotation (%). */
  sustainPwm: number;
  /** Ce ventilateur possède-t-il un retour tachymétrique ? */
  hasTach: boolean;
  // état
  pwm: number;
  enableMode: number;
  rpm: number;
  /** Bloqué mécaniquement : ne tourne plus quelle que soit la consigne. */
  stalled: boolean;
  /** Écriture refusée par le noyau (simulation d'un EACCES/EINVAL). */
  writeRefused: boolean;
  writable: boolean;
}

interface SimTemp {
  index: number;
  label: string;
  /** Identifiant logique lu par le simulateur de monde (cpu, v100-1…). */
  source: string;
  /** Capteur en panne : lecture nulle. */
  failed: boolean;
}

interface SimController {
  driverName: string;
  kernelDriver: string;
  bus: string;
  address: string;
  modalias: string | null;
  /** Index /sys courant — modifiable pour simuler un renumérotage au reboot. */
  hwmonIndex: number;
  fans: SimFan[];
  temps: SimTemp[];
  present: boolean;
}

export interface SimulatedOptions {
  /** Fournit les températures « réelles » par identifiant logique. */
  temperatureProvider?: (source: string) => number | null;
  /** Simule un système sans aucune sortie PWM (supervision seule). */
  withoutPwm?: boolean;
}

function key(driver: string, address: string): string {
  return `${driver}:sim-${address.replace(/[^a-z0-9]/gi, '')}`;
}

function defaultControllers(): SimController[] {
  return [
    {
      driverName: 'nct6798',
      kernelDriver: 'nct6775',
      bus: 'platform',
      address: 'nct6775.2592',
      modalias: 'platform:nct6775',
      hwmonIndex: 4,
      present: true,
      fans: [
        { index: 1, label: 'CPU_FAN1', maxRpm: 2200, startupPwm: 12, sustainPwm: 8, hasTach: true, pwm: 40, enableMode: SIM_MODE_BIOS, rpm: 880, stalled: false, writeRefused: false, writable: true },
        { index: 2, label: 'SYS_FAN1', maxRpm: 1500, startupPwm: 15, sustainPwm: 10, hasTach: true, pwm: 35, enableMode: SIM_MODE_BIOS, rpm: 525, stalled: false, writeRefused: false, writable: true },
        { index: 3, label: 'SYS_FAN2', maxRpm: 1500, startupPwm: 15, sustainPwm: 10, hasTach: true, pwm: 35, enableMode: SIM_MODE_BIOS, rpm: 525, stalled: false, writeRefused: false, writable: true },
        { index: 4, label: 'SYS_FAN3', maxRpm: 2800, startupPwm: 20, sustainPwm: 14, hasTach: true, pwm: 55, enableMode: SIM_MODE_BIOS, rpm: 1540, stalled: false, writeRefused: false, writable: true },
        { index: 5, label: 'SYS_FAN4', maxRpm: 2800, startupPwm: 20, sustainPwm: 14, hasTach: true, pwm: 55, enableMode: SIM_MODE_BIOS, rpm: 1540, stalled: false, writeRefused: false, writable: true },
      ],
      temps: [
        { index: 1, label: 'SYSTIN', source: 'motherboard', failed: false },
        { index: 2, label: 'CPUTIN', source: 'cpu', failed: false },
        { index: 3, label: 'Front intake', source: 'case-front', failed: false },
        { index: 4, label: 'Rear exhaust', source: 'case-rear', failed: false },
      ],
    },
    {
      driverName: 'coretemp',
      kernelDriver: 'coretemp',
      bus: 'platform',
      address: 'coretemp.0',
      modalias: 'platform:coretemp',
      hwmonIndex: 2,
      present: true,
      fans: [],
      temps: [{ index: 1, label: 'Package id 0', source: 'cpu', failed: false }],
    },
    {
      driverName: 'nvme',
      kernelDriver: 'nvme',
      bus: 'pci',
      address: '0000:04:00.0',
      modalias: 'pci:v0000144Dd0000A80A',
      hwmonIndex: 3,
      present: true,
      fans: [],
      temps: [{ index: 1, label: 'Composite', source: 'nvme', failed: false }],
    },
  ];
}

export class SimulatedHwmonBackend implements HwmonBackend {
  readonly kind = 'simulated' as const;

  private controllers: SimController[];
  private discovery: HwmonDiscovery = emptyDiscovery();
  private tachBindings = new Map<string, string | null>();
  private tempProvider: (source: string) => number | null;
  /** Compteur d'écritures — les tests l'inspectent. */
  writeCount = 0;

  constructor(private opts: SimulatedOptions = {}) {
    this.controllers = defaultControllers();
    if (opts.withoutPwm) {
      for (const c of this.controllers) c.fans = [];
    }
    this.tempProvider = opts.temperatureProvider ?? (() => null);
    this.discover();
  }

  setTemperatureProvider(fn: (source: string) => number | null): void {
    this.tempProvider = fn;
  }

  // ---------- Physique ----------

  /** Avance la simulation de `dtMs`. Appelé par la boucle du mode démo. */
  step(dtMs: number): void {
    const alpha = Math.min(1, dtMs / 1200);
    for (const c of this.controllers) {
      if (!c.present) continue;
      for (const f of c.fans) {
        const effectivePwm = this.effectivePwm(c, f);
        let target: number;
        if (f.stalled) {
          target = 0;
        } else if (f.rpm <= 5) {
          // À l'arrêt : ne redémarre qu'au-dessus du seuil de démarrage.
          target = effectivePwm >= f.startupPwm ? f.maxRpm * (effectivePwm / 100) : 0;
        } else {
          // En rotation : s'arrête sous le seuil de maintien.
          target = effectivePwm >= f.sustainPwm ? f.maxRpm * (effectivePwm / 100) : 0;
        }
        const noise = target > 0 ? (Math.random() - 0.5) * 20 : 0;
        f.rpm = Math.max(0, Math.round(f.rpm + (target - f.rpm) * alpha + noise));
        if (f.rpm < 40) f.rpm = 0;
      }
    }
  }

  /** En mode BIOS, le contrôleur matériel impose sa propre régulation. */
  private effectivePwm(_c: SimController, f: SimFan): number {
    if (f.enableMode === SIM_MODE_FULL) return 100;
    if (f.enableMode === SIM_MODE_MANUAL) return f.pwm;
    // Mode automatique : courbe interne du BIOS, indépendante de nos écritures.
    const cpu = this.tempProvider('cpu') ?? 50;
    const gpu = Math.max(this.tempProvider('v100-1') ?? 0, this.tempProvider('v100-2') ?? 0);
    const ref = f.label.startsWith('CPU') ? cpu : Math.max(cpu, gpu);
    const pct = ref <= 35 ? 25 : ref >= 85 ? 100 : 25 + ((ref - 35) / 50) * 75;
    return Math.round(pct);
  }

  // ---------- Interface HwmonBackend ----------

  discover(): HwmonDiscovery {
    const controllers: ControllerIdentity[] = [];
    const pwmOutputs: DiscoveredPwmOutput[] = [];
    const tempSensors: DiscoveredTempSensor[] = [];
    const orphanTachs: HwmonDiscovery['orphanTachs'] = [];
    const warnings: string[] = ['Contrôleurs simulés : aucune action n’atteint du matériel réel.'];

    for (const c of this.controllers) {
      if (!c.present) continue;
      const identity: ControllerIdentity = {
        key: key(c.driverName, c.address),
        driverName: c.driverName,
        kernelDriver: c.kernelDriver,
        bus: c.bus,
        address: c.address,
        modalias: c.modalias,
        currentPath: `/sys/class/hwmon/hwmon${c.hwmonIndex}`,
      };
      controllers.push(identity);

      for (const t of c.temps) {
        tempSensors.push({
          key: `${identity.key}#temp${t.index}`,
          controller: identity,
          index: t.index,
          path: `${identity.currentPath}/temp${t.index}_input`,
          label: t.label,
          valueC: t.failed ? null : this.tempProvider(t.source),
          mappedTo: null,
        });
      }

      const usedTach = new Set<number>();
      for (const f of c.fans) {
        const outKey = `${identity.key}#pwm${f.index}`;
        const bound = this.tachBindings.get(outKey);
        let tachIndex: number | null = null;
        if (bound === undefined) tachIndex = f.hasTach ? f.index : null;
        else if (bound !== null) tachIndex = Number(bound.split('#fan')[1]);
        if (tachIndex !== null) usedTach.add(tachIndex);
        const tachFan = tachIndex !== null ? c.fans.find((x) => x.index === tachIndex) : null;

        pwmOutputs.push({
          key: outKey,
          controller: identity,
          index: f.index,
          pwmPath: `${identity.currentPath}/pwm${f.index}`,
          enablePath: `${identity.currentPath}/pwm${f.index}_enable`,
          supportedEnableModes: [],
          currentEnableMode: f.enableMode,
          currentPwm: f.pwm,
          tachPath: tachFan?.hasTach ? `${identity.currentPath}/fan${tachIndex}_input` : null,
          tachIndex: tachFan?.hasTach ? tachIndex : null,
          currentRpm: tachFan?.hasTach ? tachFan.rpm : null,
          label: f.label,
          writable: f.writable,
        });
      }

      for (const f of c.fans) {
        if (f.hasTach && !usedTach.has(f.index)) {
          orphanTachs.push({
            key: `${identity.key}#fan${f.index}`,
            controller: identity,
            index: f.index,
            path: `${identity.currentPath}/fan${f.index}_input`,
            rpm: f.rpm,
          });
        }
      }
    }

    if (pwmOutputs.length === 0) {
      warnings.push('Aucune sortie PWM simulée : supervision uniquement.');
    }
    this.discovery = { controllers, pwmOutputs, tempSensors, orphanTachs, warnings };
    return this.discovery;
  }

  cached(): HwmonDiscovery {
    return this.discovery;
  }

  getOutput(k: string): DiscoveredPwmOutput | null {
    return this.discovery.pwmOutputs.find((o) => o.key === k) ?? null;
  }

  getTempSensor(k: string): DiscoveredTempSensor | null {
    return this.discovery.tempSensors.find((s) => s.key === k) ?? null;
  }

  private locate(k: string): { c: SimController; f: SimFan } {
    for (const c of this.controllers) {
      if (!c.present) continue;
      const ck = key(c.driverName, c.address);
      if (!k.startsWith(`${ck}#pwm`)) continue;
      const idx = Number(k.split('#pwm')[1]);
      const f = c.fans.find((x) => x.index === idx);
      if (f) return { c, f };
    }
    throw new HwmonError(`Sortie PWM inconnue : ${k}`, 'NOT_FOUND');
  }

  readPwmPercent(k: string): number | null {
    return this.locate(k).f.pwm;
  }

  writePwmPercent(k: string, percent: number): void {
    if (!Number.isFinite(percent)) throw new HwmonError('Consigne PWM invalide', 'INVALID');
    const { f } = this.locate(k);
    if (!f.writable) throw new HwmonError(`Sortie ${k} non inscriptible`, 'NOT_WRITABLE');
    if (f.writeRefused) throw new HwmonError(`Écriture refusée par le pilote simulé (${k})`, 'IO');
    f.pwm = Math.max(0, Math.min(100, Math.round(percent)));
    this.writeCount++;
  }

  readEnableMode(k: string): number | null {
    return this.locate(k).f.enableMode;
  }

  writeEnableMode(k: string, mode: number): void {
    const { f } = this.locate(k);
    if (f.writeRefused) throw new HwmonError(`Changement de mode refusé (${k})`, 'IO');
    if (![SIM_MODE_FULL, SIM_MODE_MANUAL, SIM_MODE_BIOS].includes(mode)) {
      throw new HwmonError(`Mode pwm_enable non supporté par le pilote simulé : ${mode}`, 'INVALID');
    }
    f.enableMode = mode;
  }

  readRpm(k: string): number | null {
    const out = this.getOutput(k);
    if (!out || out.tachIndex === null) return null;
    const { c } = this.locate(k);
    const tach = c.fans.find((x) => x.index === out.tachIndex);
    return tach && tach.hasTach ? tach.rpm : null;
  }

  readRpmByTachKey(tachKey: string): number | null {
    for (const c of this.controllers) {
      if (!c.present) continue;
      const ck = key(c.driverName, c.address);
      if (!tachKey.startsWith(`${ck}#fan`)) continue;
      const idx = Number(tachKey.split('#fan')[1]);
      const f = c.fans.find((x) => x.index === idx);
      return f && f.hasTach ? f.rpm : null;
    }
    return null;
  }

  tachKeysForController(ctrlKey: string): { key: string; index: number; path: string }[] {
    const c = this.controllers.find((x) => x.present && key(x.driverName, x.address) === ctrlKey);
    if (!c) return [];
    return c.fans.filter((f) => f.hasTach).map((f) => ({
      key: `${ctrlKey}#fan${f.index}`,
      index: f.index,
      path: `/sys/class/hwmon/hwmon${c.hwmonIndex}/fan${f.index}_input`,
    }));
  }

  readTempC(sensorKey: string): number | null {
    for (const c of this.controllers) {
      if (!c.present) continue;
      const ck = key(c.driverName, c.address);
      if (!sensorKey.startsWith(`${ck}#temp`)) continue;
      const idx = Number(sensorKey.split('#temp')[1]);
      const t = c.temps.find((x) => x.index === idx);
      if (!t) return null;
      return t.failed ? null : this.tempProvider(t.source);
    }
    return null;
  }

  bindTach(outputKey: string, tachKey: string | null): void {
    this.tachBindings.set(outputKey, tachKey);
    this.discover();
  }

  // ---------- Leviers de scénario (démo & tests) ----------

  /** Bloque mécaniquement un ventilateur : RPM = 0 malgré la consigne. */
  setStalled(label: string, stalled: boolean): void {
    const f = this.fanByLabel(label);
    if (f) f.stalled = stalled;
  }

  /** Le pilote refuse toute écriture sur cette sortie. */
  setWriteRefused(label: string, refused: boolean): void {
    const f = this.fanByLabel(label);
    if (f) f.writeRefused = refused;
  }

  /** Rend une sortie non inscriptible (permissions insuffisantes, pilote
   *  en lecture seule). Distinct de `setWriteRefused` : ici, l'écriture n'est
   *  même pas tentée. */
  setWritable(label: string, writable: boolean): void {
    const f = this.fanByLabel(label);
    if (f) {
      f.writable = writable;
      this.discover();
    }
  }

  /** Retire le retour tachymétrique d'une sortie. */
  setTachAvailable(label: string, available: boolean): void {
    const f = this.fanByLabel(label);
    if (f) {
      f.hasTach = available;
      this.discover();
    }
  }

  /** Met un capteur en panne (lecture nulle). */
  setSensorFailed(source: string, failed: boolean): void {
    for (const c of this.controllers) {
      for (const t of c.temps) if (t.source === source) t.failed = failed;
    }
    this.discover();
  }

  /** Simule un renumérotage des index /sys après redémarrage.
   *  L'empreinte stable ne doit pas changer : c'est précisément ce qui est testé. */
  shuffleHwmonIndexes(): void {
    const indexes = this.controllers.map((c) => c.hwmonIndex);
    indexes.reverse();
    this.controllers.forEach((c, i) => { c.hwmonIndex = indexes[i]; });
    this.discover();
  }

  /** Fait disparaître (ou réapparaître) un contrôleur entier. */
  setControllerPresent(driverName: string, present: boolean): void {
    const c = this.controllers.find((x) => x.driverName === driverName);
    if (c) {
      c.present = present;
      this.discover();
    }
  }

  /** Remplace un contrôleur par un autre modèle : la calibration doit être invalidée. */
  replaceController(driverName: string, replacement: { driverName: string; kernelDriver: string; address: string }): void {
    const c = this.controllers.find((x) => x.driverName === driverName);
    if (!c) return;
    c.driverName = replacement.driverName;
    c.kernelDriver = replacement.kernelDriver;
    c.address = replacement.address;
    c.modalias = `platform:${replacement.kernelDriver}`;
    this.discover();
  }

  /** Supprime une sortie PWM (câble débranché / pilote partiel). */
  removeOutput(label: string): void {
    for (const c of this.controllers) {
      c.fans = c.fans.filter((f) => f.label !== label);
    }
    this.discover();
  }

  /** Force un RPM arbitraire (tests de cohérence). */
  forceRpm(label: string, rpm: number): void {
    const f = this.fanByLabel(label);
    if (f) f.rpm = rpm;
  }

  /** Clé de sortie PWM correspondant à un libellé simulé (aide aux tests). */
  outputKeyByLabel(label: string): string | null {
    for (const c of this.controllers) {
      if (!c.present) continue;
      const f = c.fans.find((x) => x.label === label);
      if (f) return `${key(c.driverName, c.address)}#pwm${f.index}`;
    }
    return null;
  }

  private fanByLabel(label: string): SimFan | null {
    for (const c of this.controllers) {
      const f = c.fans.find((x) => x.label === label);
      if (f) return f;
    }
    return null;
  }
}
