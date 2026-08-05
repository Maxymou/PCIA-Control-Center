/** Moteur de régulation des ventilateurs.
 *
 *  Conçu pour tourner **sans interface et sans API** : il lit sa configuration
 *  dans SQLite, ses capteurs directement, et écrit les PWM lui-même. L'arrêt de
 *  l'API n'a aucun effet sur cette boucle.
 *
 *  Principes de sûreté appliqués ici :
 *   - au démarrage, toutes les sorties restent sous contrôle **BIOS** ;
 *   - une sortie ne passe sous contrôle logiciel qu'après calibration complète
 *     ET retour BIOS confirmé (sauf désactivation explicite de l'exigence) ;
 *   - toute anomalie fait monter la consigne, jamais descendre ;
 *   - la dernière courbe valide est conservée si une courbe invalide arrive ;
 *   - à l'arrêt, les sorties sont restituées au BIOS puis vérifiées.
 */

import type { AppConfig } from '../config.js';
import type {
  CalibrationRecord, FanConfig, FanControlState, FanCurve, FanEngineState, FanId,
  FanOutputState, HardwareId, RpmSource, Severity, UnconnectedOutputState,
} from '../contract.js';
import { FAN_IDS } from '../contract.js';
import type { Repositories } from '../db/repositories.js';
import { createLogger } from '../logger.js';
import type { HwmonBackend } from '../hwmon/backend.js';
import { HwmonError } from '../hwmon/backend.js';
import {
  collectTachs, resolveFanMapping, type ResolvedFanMapping, type ResolvedUnconnected,
} from '../hwmon/mapping.js';
import { readSystemInfo } from '../system/info.js';
import { evalCurve, validateCurve } from './curve.js';
import { effectiveMinPwm, PASSIVE_COOLING_FANS } from './defaults.js';
import {
  applyLimits, emptyStallState, rpmInconsistent, sensorSafety, temperatureSafety,
  updateStall, type SafetyDecision, type StallState,
} from './safety.js';
import { resolveRefTemp, type SensorSource } from './sensorSource.js';

const log = createLogger('fan.engine');

export interface EngineEvent {
  category: 'fan' | 'temperature' | 'config' | 'alert' | 'hardware';
  level: Severity;
  targetLabel: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface EngineAlert {
  type: 'FAN_STALLED' | 'FAN_RPM_INCONSISTENT' | 'SENSOR_UNAVAILABLE' | 'PWM_WRITE_FAILED'
  | 'BIOS_RETURN_FAILED' | 'CRITICAL_TEMPERATURE';
  level: 'warning' | 'critical';
  fanId: FanId;
  label: string;
  message: string;
  value?: string;
  threshold?: string;
  recommendation?: string;
  /** `false` : la cause a disparu, l'alerte doit être résolue. */
  active: boolean;
}

export interface EngineDeps {
  config: AppConfig;
  hwmon: HwmonBackend;
  repos: Repositories;
  sensors: SensorSource;
  mode: 'hardware' | 'demo';
  onEvent?: (e: EngineEvent) => void;
  onAlert?: (a: EngineAlert) => void;
  onState?: (s: FanEngineState) => void;
}

interface OutputRuntime {
  id: FanId;
  config: FanConfig;
  calibration: CalibrationRecord;
  controlState: FanControlState;
  /** Sortie réellement **écrite**. Ne vient que de la calibration : c'est la
   *  seule procédure qui vérifie physiquement la sortie et le retour au BIOS. */
  boundOutputKey: string | null;
  /** Sortie **observée** (consigne courante, RPM). Vient du mappage déclaratif
   *  quand il existe, sinon de la calibration. Lire n'engage rien. */
  monitorOutputKey: string | null;
  mappingSource: 'config' | 'calibration' | 'none';
  connectorLabel: string | null;
  /** Dernière courbe valide — conservée si une courbe invalide est chargée. */
  lastValidCurve: FanCurve;
  pwm: number;
  requestedPwm: number;
  rpm: number | null;
  rpmSource: RpmSource;
  refTemp: number | null;
  sensorLostSince: number | null;
  stall: StallState;
  stalled: boolean;
  writeFailures: number;
  lastWriteError: string | null;
  /** Test temporaire en cours (timestamp de fin). */
  testUntil: number | null;
  /** Forçage 100 % demandé depuis l'API (timestamp de fin, null = permanent). */
  forceMaxUntil: number | null;
  forceMax: boolean;
  severity: Severity;
  /** Mode pwm_enable observé avant toute prise de contrôle (= mode BIOS). */
  observedBiosMode: number | null;
  lastSafetyReason: string;
  /** Épisode de température critique en cours (évite les alertes en rafale). */
  criticalTempActive: boolean;
  /** Sortie pilotée par l'assistant de calibration : le moteur ne la touche pas. */
  suspendedForCalibration: boolean;
}

/** Mode `pwm_enable` correspondant au pilotage manuel sur les pilotes courants. */
export const MANUAL_ENABLE_MODE = 1;

export class FanEngine {
  private outputs = new Map<FanId, OutputRuntime>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRevision = -1;
  private started = false;
  private stopping = false;
  private warnings: string[] = [];
  private lastHeartbeat = 0;
  /** Mappage déclaratif résolu contre la découverte courante. */
  private mapping = new Map<FanId, ResolvedFanMapping>();
  /** Connecteurs déclarés non raccordés — lus, jamais écrits. */
  private unconnected: ResolvedUnconnected[] = [];
  private mappingWarnings: string[] = [];

  constructor(private deps: EngineDeps) {}

  // =====================================================================
  // Démarrage
  // =====================================================================

  /** Découvre le matériel, revalide les calibrations, puis démarre la boucle. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.hwmon.discover();
    this.deps.sensors.refreshMap();
    this.loadConfiguration({ initial: true });
    this.applyDeclaredMapping();
    this.restoreTachBindings();
    this.evaluateControlTakeover();

    const interval = this.deps.config.fanControl.loopIntervalMs;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Une exception dans la boucle ne doit jamais l'arrêter.
        log.error('Erreur dans la boucle de régulation', { error: err });
      }
    }, interval);
    this.tick();
    log.info('Moteur de ventilation démarré', {
      mode: this.deps.mode,
      intervalMs: interval,
      outputs: [...this.outputs.values()].map((o) => ({ id: o.id, state: o.controlState })),
    });
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** Réapplique les liaisons tachymétriques confirmées par la calibration.
   *
   *  Le mappage déclaratif est prioritaire : s'il désigne explicitement un canal
   *  RPM pour une sortie, la valeur relevée en calibration ne l'écrase pas. */
  private restoreTachBindings(): void {
    for (const o of this.outputs.values()) {
      if (!o.boundOutputKey || o.calibration.tachIndex === null) continue;
      if (this.mapping.get(o.id)?.tachKey !== undefined) continue;
      const output = this.deps.hwmon.getOutput(o.boundOutputKey);
      if (!output) continue;
      const tachKey = `${output.controller.key}#fan${o.calibration.tachIndex}`;
      const known = this.deps.hwmon.tachKeysForController(output.controller.key).some((t) => t.key === tachKey);
      this.deps.hwmon.bindTach(o.boundOutputKey, known ? tachKey : null);
    }
  }

  /** Résout le mappage déclaré dans config.yaml et applique les canaux RPM.
   *
   *  À appeler après chaque (re)découverte : c'est ce qui rend le programme
   *  insensible à la renumérotation des `hwmonN` après un redémarrage — les
   *  sorties sont retrouvées par identité de contrôleur ou par device, jamais
   *  par le numéro qu'elles portaient la fois précédente.
   *
   *  Ce mappage n'autorise **aucune** écriture : il désigne quoi lire et sur
   *  quel canal, rien de plus. */
  private applyDeclaredMapping(): void {
    const declared = this.deps.config.fans.mapping;
    const declaredUnconnected = this.deps.config.fans.unconnected;
    this.mapping = new Map();
    this.unconnected = [];
    this.mappingWarnings = [];

    const hasMapping = declared && Object.keys(declared).length > 0;
    const hasUnconnected = declaredUnconnected && Object.keys(declaredUnconnected).length > 0;
    if (!hasMapping && !hasUnconnected) return;

    const discovery = this.deps.hwmon.cached();
    const tachs = collectTachs(discovery, (key) => this.deps.hwmon.tachKeysForController(key));

    if (hasMapping) this.mapping = resolveFanMapping(declared, discovery, tachs);

    for (const resolved of this.mapping.values()) {
      for (const w of resolved.warnings) {
        this.mappingWarnings.push(w);
        log.throttled(`mapping-${w}`, 600_000, 'warn', w);
      }
      // Le canal RPM déclaré est appliqué au backend : c'est lui que liront la
      // supervision *et* la détection de ventilateur bloqué.
      if (resolved.outputKey && resolved.tachKey !== undefined) {
        this.deps.hwmon.bindTach(resolved.outputKey, resolved.tachKey);
      }
    }

    if (!hasUnconnected) return;
    this.unconnected = [...resolveFanMapping<string>(declaredUnconnected, discovery, tachs).values()];
    const controlled = new Set(
      [...this.mapping.values()].map((m) => m.outputKey).filter((k): k is string => k !== null),
    );
    for (const entry of this.unconnected) {
      for (const w of entry.warnings) {
        this.mappingWarnings.push(w);
        log.throttled(`unconnected-${w}`, 600_000, 'warn', w);
      }
      // Garde-fou : une sortie ne peut pas être à la fois pilotée et déclarée
      // non branchée. En cas de conflit, la déclaration « non branché » est
      // écartée — sinon on cesserait de surveiller un ventilateur bien réel.
      if (entry.outputKey && controlled.has(entry.outputKey)) {
        const w = `${entry.fanId} : la sortie ${entry.outputKey} est déjà attribuée à une sortie logique `
          + '— déclaration « non branché » ignorée.';
        this.mappingWarnings.push(w);
        log.warn(w);
        entry.outputKey = null;
        entry.unresolved = true;
        continue;
      }
      if (entry.outputKey && entry.tachKey !== undefined) {
        this.deps.hwmon.bindTach(entry.outputKey, entry.tachKey);
      }
    }
  }

  /** Sorties PWM déclarées non raccordées — la calibration doit les refuser. */
  unconnectedOutputKeys(): Set<string> {
    return new Set(this.unconnected.map((u) => u.outputKey).filter((k): k is string => k !== null));
  }

  /** Nom du connecteur déclaré non raccordé pour une sortie donnée. */
  unconnectedLabelFor(outputKey: string): string | null {
    return this.unconnected.find((u) => u.outputKey === outputKey)?.fanId ?? null;
  }

  private unconnectedState(): UnconnectedOutputState[] {
    return this.unconnected.map((u): UnconnectedOutputState => {
      // Lecture normale : sur un connecteur vide, 0 RPM est la bonne réponse et
      // c'est une **mesure**, pas une absence de mesure.
      const raw = u.outputKey ? this.deps.hwmon.readRpm(u.outputKey) : null;
      const valid = raw !== null && Number.isFinite(raw) && raw >= 0;
      return {
        label: u.connectorLabel ?? u.fanId,
        outputKey: u.outputKey,
        rpm: valid ? raw : null,
        rpmSource: !valid
          ? 'unavailable'
          : this.deps.hwmon.kind === 'simulated' ? 'simulated' : 'measured',
        hwmonPath: u.outputKey ? this.deps.hwmon.getOutput(u.outputKey)?.pwmPath ?? null : null,
      };
    });
  }

  // =====================================================================
  // Configuration
  // =====================================================================

  private loadConfiguration(opts: { initial?: boolean } = {}): void {
    const configs = new Map(this.deps.repos.fanConfigs.list().map((c) => [c.id, c]));
    const calibrations = new Map(this.deps.repos.calibration.list().map((c) => [c.fanId, c]));
    this.lastRevision = this.deps.repos.fanConfigs.revision();

    for (const id of FAN_IDS) {
      const config = configs.get(id);
      const calibration = calibrations.get(id);
      if (!config || !calibration) continue;

      const validation = validateCurve(config.curve);
      const existing = this.outputs.get(id);
      // Courbe invalide : la dernière courbe valide est conservée.
      const curve = validation.ok
        ? validation.curve!
        : existing?.lastValidCurve ?? [{ temp: 30, pwm: 40 }, { temp: 80, pwm: 100 }];
      if (!validation.ok) {
        log.warn('Courbe invalide en base — dernière courbe valide conservée', { fanId: id, errors: validation.errors });
        this.emitEvent({
          category: 'fan', level: 'warning', targetLabel: config.displayName,
          message: 'Courbe invalide détectée en configuration — dernière courbe valide conservée.',
        });
      }

      if (existing) {
        const curveChanged = JSON.stringify(existing.config.curve) !== JSON.stringify(config.curve);
        const modeChanged = existing.config.mode !== config.mode;
        existing.config = { ...config, curve };
        existing.lastValidCurve = curve;
        const calibrationChanged = existing.calibration.state !== calibration.state
          || existing.calibration.outputKey !== calibration.outputKey
          || existing.calibration.biosReturn !== calibration.biosReturn;
        existing.calibration = calibration;
        if (calibrationChanged) this.evaluateControlTakeover(id);
        if (modeChanged) {
          this.emitEvent({
            category: 'fan', level: 'normal', targetLabel: config.displayName,
            message: `Mode de ventilation : ${config.mode}`,
          });
        }
        if (curveChanged && !opts.initial) {
          this.emitEvent({
            category: 'fan', level: 'normal', targetLabel: config.displayName,
            message: 'Nouvelle courbe de ventilation appliquée.',
          });
        }
        continue;
      }

      this.outputs.set(id, {
        id,
        config: { ...config, curve },
        calibration,
        controlState: 'BIOS_CONTROLLED',
        boundOutputKey: null,
        monitorOutputKey: null,
        mappingSource: 'none',
        connectorLabel: null,
        lastValidCurve: curve,
        pwm: 0,
        requestedPwm: 0,
        rpm: null,
        rpmSource: 'unavailable',
        refTemp: null,
        sensorLostSince: null,
        stall: emptyStallState(),
        stalled: false,
        writeFailures: 0,
        lastWriteError: null,
        testUntil: null,
        forceMaxUntil: null,
        forceMax: false,
        severity: 'unknown',
        observedBiosMode: null,
        lastSafetyReason: 'none',
        criticalTempActive: false,
        suspendedForCalibration: false,
      });
    }
  }

  /** Revalide la liaison matérielle d'une sortie et décide de la prise de contrôle. */
  private evaluateControlTakeover(only?: FanId): void {
    const sysInfo = readSystemInfo();
    const warnings: string[] = [...this.mappingWarnings];

    for (const runtime of this.outputs.values()) {
      if (only && runtime.id !== only) continue;
      if (runtime.suspendedForCalibration) continue;

      const cal = runtime.calibration;
      runtime.boundOutputKey = null;

      // --- 0. Mappage déclaratif : ce que l'on observe, avant toute calibration.
      const declared = this.mapping.get(runtime.id);
      runtime.connectorLabel = declared?.connectorLabel ?? runtime.id;
      if (declared?.outputKey && this.deps.hwmon.getOutput(declared.outputKey)) {
        runtime.monitorOutputKey = declared.outputKey;
        runtime.mappingSource = 'config';
      } else {
        runtime.monitorOutputKey = null;
        runtime.mappingSource = 'none';
      }
      // Divergence configuration / calibration : on la signale sans rien casser.
      // La calibration prime pour l'observation comme pour l'écriture, sinon on
      // écrirait sur une sortie et on lirait la vitesse d'une autre.
      if (declared?.outputKey && cal.outputKey && declared.outputKey !== cal.outputKey) {
        warnings.push(
          `${runtime.id} : le mappage de config.yaml (${declared.outputKey}) diffère de la sortie calibrée `
          + `(${cal.outputKey}) — la calibration fait foi.`,
        );
      }

      if (cal.state === 'NOT_CALIBRATED' || !cal.outputKey) {
        runtime.controlState = 'BIOS_CONTROLLED';
        continue;
      }

      // 1. Retrouver la sortie par son identifiant stable, pas par son index.
      const output = this.deps.hwmon.getOutput(cal.outputKey);
      if (!output) {
        this.invalidate(runtime, 'Sortie PWM calibrée introuvable après redécouverte du matériel.');
        warnings.push(`${runtime.id} : sortie calibrée absente — contrôle laissé au BIOS.`);
        continue;
      }

      // La sortie calibrée existe : c'est elle que l'on observe, même si la prise
      // de contrôle est ensuite refusée (état BIOS avec supervision complète).
      runtime.monitorOutputKey = cal.outputKey;
      runtime.mappingSource = 'calibration';

      // 2. Comparer les capacités : une perte de tachymètre change la donne.
      if (cal.tachIndex !== null && output.tachIndex === null) {
        this.invalidate(runtime, 'Retour tachymétrique disparu depuis la calibration.');
        warnings.push(`${runtime.id} : tachymètre absent — contrôle laissé au BIOS.`);
        continue;
      }
      if (!output.writable) {
        this.invalidate(runtime, 'Sortie PWM non inscriptible (permissions ou pilote).');
        warnings.push(`${runtime.id} : sortie non inscriptible — contrôle laissé au BIOS.`);
        continue;
      }

      // 3. Un changement de BIOS ou de noyau invalide le retour BIOS validé.
      if (cal.biosVersion && sysInfo.biosVersion && cal.biosVersion !== sysInfo.biosVersion) {
        this.invalidate(runtime, `Version du BIOS différente (${cal.biosVersion} → ${sysInfo.biosVersion}) — recalibration requise.`);
        warnings.push(`${runtime.id} : BIOS modifié — retour BIOS à revalider.`);
        continue;
      }
      if (cal.kernelVersion && cal.kernelVersion !== sysInfo.kernel) {
        this.invalidate(runtime, `Noyau différent (${cal.kernelVersion} → ${sysInfo.kernel}) — recalibration requise.`);
        warnings.push(`${runtime.id} : noyau modifié — retour BIOS à revalider.`);
        continue;
      }

      if (cal.invalidatedReason) {
        runtime.controlState = 'BIOS_CONTROLLED';
        continue;
      }

      runtime.boundOutputKey = cal.outputKey;
      runtime.observedBiosMode = cal.biosEnableMode ?? output.currentEnableMode;

      // 4. Autorisation de prise de contrôle.
      const authorized = cal.state === 'AUTHORIZED';
      const biosReturnOk = !this.deps.config.fanControl.requireBiosReturnValidation
        || cal.biosReturn === 'CONFIRMED';
      if (!authorized) {
        runtime.controlState = cal.state === 'RESTRICTED' ? 'BIOS_CONTROLLED' : 'BIOS_CONTROLLED';
        continue;
      }
      if (!biosReturnOk) {
        runtime.controlState = 'BIOS_CONTROLLED';
        warnings.push(`${runtime.id} : retour BIOS non confirmé — contrôle logiciel automatique refusé.`);
        continue;
      }

      this.takeSoftwareControl(runtime);
    }

    this.warnings = warnings;
  }

  private invalidate(runtime: OutputRuntime, reason: string): void {
    runtime.controlState = 'BIOS_CONTROLLED';
    runtime.boundOutputKey = null;
    if (runtime.calibration.invalidatedReason === reason) return;
    const updated: CalibrationRecord = { ...runtime.calibration, invalidatedReason: reason, state: 'RESTRICTED' };
    runtime.calibration = updated;
    try {
      this.deps.repos.calibration.save(updated);
    } catch (err) {
      log.error('Enregistrement de l’invalidation impossible', { fanId: runtime.id, error: err });
    }
    log.warn('Calibration invalidée', { fanId: runtime.id, reason });
    this.emitEvent({
      category: 'fan', level: 'warning', targetLabel: runtime.config.displayName,
      message: `Calibration invalidée : ${reason}`,
    });
  }

  /** Passe une sortie sous contrôle logiciel, en vérifiant que l'écriture prend. */
  private takeSoftwareControl(runtime: OutputRuntime): void {
    if (!runtime.boundOutputKey) return;
    runtime.controlState = 'SOFTWARE_STARTING';
    const manualMode = runtime.calibration.manualEnableMode ?? MANUAL_ENABLE_MODE;
    try {
      const output = this.deps.hwmon.getOutput(runtime.boundOutputKey);
      if (output?.enablePath) {
        const current = this.deps.hwmon.readEnableMode(runtime.boundOutputKey);
        if (runtime.observedBiosMode === null) runtime.observedBiosMode = current;
        this.deps.hwmon.writeEnableMode(runtime.boundOutputKey, manualMode);
        const after = this.deps.hwmon.readEnableMode(runtime.boundOutputKey);
        if (after !== null && after !== manualMode) {
          throw new HwmonError(`Le pilote a refusé le mode manuel (${after})`, 'UNSUPPORTED');
        }
      }
      runtime.controlState = 'SOFTWARE_CONTROLLED';
      runtime.writeFailures = 0;
      runtime.lastWriteError = null;
      log.info('Contrôle logiciel activé', { fanId: runtime.id, outputKey: runtime.boundOutputKey });
      this.emitEvent({
        category: 'fan', level: 'normal', targetLabel: runtime.config.displayName,
        message: 'Prise de contrôle logiciel de la sortie.',
      });
    } catch (err) {
      runtime.controlState = 'ERROR';
      runtime.lastWriteError = (err as Error).message;
      log.error('Prise de contrôle logiciel impossible', { fanId: runtime.id, error: err });
      this.emitAlert({
        type: 'PWM_WRITE_FAILED', level: 'critical', fanId: runtime.id,
        label: runtime.config.displayName,
        message: 'Prise de contrôle logiciel impossible — la sortie reste pilotée par le BIOS.',
        recommendation: 'Vérifier les permissions sysfs et relancer la calibration.',
        active: true,
      });
      this.returnToBios(runtime, 'échec de prise de contrôle');
    }
  }

  // =====================================================================
  // Boucle
  // =====================================================================

  private tick(): void {
    const now = Date.now();
    const config = this.deps.config;

    // Rechargement de configuration si l'API a écrit en base.
    const revision = this.deps.repos.fanConfigs.revision();
    if (revision !== this.lastRevision) {
      this.loadConfiguration();
      this.evaluateControlTakeover();
    }

    this.deps.sensors.pollGpus(now);

    for (const runtime of this.outputs.values()) {
      if (runtime.suspendedForCalibration) {
        // La calibration pilote cette sortie : on se contente d'observer.
        this.readRpm(runtime);
        continue;
      }
      this.tickOutput(runtime, now, config);
    }

    this.publishState(now);
  }

  private tickOutput(runtime: OutputRuntime, now: number, config: AppConfig): void {
    // --- 1. Température de référence ---
    const { value: refTemp, missing } = resolveRefTemp(runtime.config.sensor, this.deps.sensors);
    runtime.refTemp = refTemp;
    if (refTemp === null) {
      runtime.sensorLostSince ??= now;
    } else if (runtime.sensorLostSince !== null) {
      runtime.sensorLostSince = null;
      this.emitAlert({
        type: 'SENSOR_UNAVAILABLE', level: 'warning', fanId: runtime.id,
        label: runtime.config.displayName, message: 'Capteur de référence de nouveau disponible.',
        active: false,
      });
    }

    // --- 2. Consigne demandée ---
    let requested: number;
    let allowStop = false;
    const testActive = runtime.testUntil !== null && now < runtime.testUntil;
    if (runtime.testUntil !== null && !testActive) {
      runtime.testUntil = null;
      this.emitEvent({
        category: 'fan', level: 'normal', targetLabel: runtime.config.displayName,
        message: 'Fin du test temporaire — retour à la régulation normale.',
      });
    }
    const forceMaxActive = runtime.forceMax
      && (runtime.forceMaxUntil === null || now < runtime.forceMaxUntil);
    if (!forceMaxActive && runtime.forceMax) runtime.forceMax = false;

    if (forceMaxActive) {
      requested = 100;
    } else if (testActive) {
      requested = 100;
    } else {
      switch (runtime.config.mode) {
        case 'manual':
          requested = runtime.config.manualPwm;
          allowStop = runtime.config.manualPwm === 0;
          break;
        case 'full':
          requested = 100;
          break;
        case 'test':
          requested = evalCurve(runtime.lastValidCurve, refTemp ?? 60);
          break;
        default:
          requested = refTemp === null ? config.fanControl.sensorFailurePwm : evalCurve(runtime.lastValidCurve, refTemp);
      }
    }
    runtime.requestedPwm = Math.round(requested);

    // --- 3. Sécurités : elles ne peuvent que faire monter la consigne ---
    const decisions: SafetyDecision[] = [
      sensorSafety({ lostSince: runtime.sensorLostSince }, config, now),
      temperatureSafety(refTemp, config),
    ];
    if (runtime.stalled) {
      decisions.push({
        forcedPwm: 100, reason: 'fan-stalled', alert: 'critical',
        message: 'Ventilateur bloqué — consigne maximale sur cette sortie.',
      });
    }
    if (runtime.controlState === 'FAILSAFE') {
      decisions.push({
        forcedPwm: config.fanControl.criticalPwm, reason: 'write-failure', alert: 'critical',
        message: 'Sortie en mode sécurité après échec d’écriture.',
      });
    }

    let target = runtime.requestedPwm;
    let reason = 'none';
    for (const d of decisions) {
      if (d.forcedPwm !== null && d.forcedPwm > target) {
        target = d.forcedPwm;
        reason = d.reason;
      }
    }

    // Alertes capteur (une seule fois par épisode).
    const sensorDecision = decisions[0];
    if (sensorDecision.reason !== 'none' && runtime.lastSafetyReason !== sensorDecision.reason) {
      this.emitAlert({
        type: 'SENSOR_UNAVAILABLE',
        level: sensorDecision.alert === 'critical' ? 'critical' : 'warning',
        fanId: runtime.id, label: runtime.config.displayName,
        message: sensorDecision.message ?? 'Capteur indisponible',
        value: missing.length ? missing.join(', ') : undefined,
        recommendation: 'Vérifier la présence du capteur et le pilote associé.',
        active: true,
      });
    }
    const tempDecision = decisions[1];
    const wasCriticalTemp = runtime.criticalTempActive;
    runtime.criticalTempActive = tempDecision.reason === 'critical-temperature';
    if (runtime.criticalTempActive && !wasCriticalTemp) {
      this.emitAlert({
        type: 'CRITICAL_TEMPERATURE', level: 'critical', fanId: runtime.id,
        label: runtime.config.displayName,
        message: tempDecision.message ?? 'Température de référence critique',
        value: refTemp !== null ? `${refTemp.toFixed(1)} °C` : undefined,
        threshold: `${config.alerts.criticalTemperatureC} °C`,
        active: true,
      });
    } else if (!runtime.criticalTempActive && wasCriticalTemp) {
      // La cause a disparu : l'alerte doit être résolue, pas laissée active.
      this.emitAlert({
        type: 'CRITICAL_TEMPERATURE', level: 'critical', fanId: runtime.id,
        label: runtime.config.displayName, message: 'Température revenue sous le seuil critique.',
        active: false,
      });
    }
    runtime.lastSafetyReason = reason;

    // --- 4. Limites ---
    const hardFloor = PASSIVE_COOLING_FANS.includes(runtime.id)
      ? config.fanControl.passiveGpuFloorPwm
      : 0;
    const pwm = applyLimits({
      fanId: runtime.id,
      requestedPwm: target,
      minPwm: effectiveMinPwm(runtime.id, runtime.config.minPwm),
      hardFloor,
      allowStop: allowStop && reason === 'none',
    });

    // --- 5. Application ---
    if (runtime.controlState === 'SOFTWARE_CONTROLLED' || runtime.controlState === 'FAILSAFE') {
      this.writePwm(runtime, pwm, config);
    } else {
      // Sous contrôle BIOS : on observe sans écrire.
      runtime.pwm = runtime.monitorOutputKey
        ? this.deps.hwmon.readPwmPercent(runtime.monitorOutputKey) ?? 0
        : 0;
    }

    // --- 6. Retour tachymétrique ---
    this.readRpm(runtime);

    // --- 7. Ventilateur bloqué ---
    // La détection s'appuie sur le canal RPM effectivement associé à cette
    // sortie — celui du mappage déclaré s'il existe, sinon celui confirmé par la
    // calibration. Sans canal, elle reste désactivée : mieux vaut ne rien
    // détecter que déclencher sur la vitesse d'un autre ventilateur.
    const hasTach = runtime.monitorOutputKey
      ? (this.deps.hwmon.getOutput(runtime.monitorOutputKey)?.tachPath ?? null) !== null
      : false;
    const stallResult = updateStall(
      runtime.stall,
      {
        pwm: runtime.pwm,
        rpm: runtime.rpm,
        hasTach,
        // Détection désactivée pour les sorties sans tachymètre.
        enabled: hasTach && runtime.controlState === 'SOFTWARE_CONTROLLED',
      },
      config,
      now,
    );
    const wasStalled = runtime.stalled;
    runtime.stall = stallResult.state;
    runtime.stalled = stallResult.stalled;
    if (stallResult.justDetected) {
      log.error('Ventilateur bloqué', { fanId: runtime.id, pwm: runtime.pwm });
      this.emitAlert({
        type: 'FAN_STALLED', level: 'critical', fanId: runtime.id, label: runtime.config.displayName,
        message: 'Ventilateur arrêté malgré une consigne active',
        value: '0 RPM', threshold: `Consigne ${runtime.pwm} %`,
        recommendation: 'Vérifier le branchement et la rotation du ventilateur.',
        active: true,
      });
      this.emitEvent({
        category: 'fan', level: 'critical', targetLabel: runtime.config.displayName,
        message: 'Ventilateur bloqué détecté — consigne portée à 100 %.',
      });
    } else if (wasStalled && !runtime.stalled) {
      this.emitAlert({
        type: 'FAN_STALLED', level: 'critical', fanId: runtime.id,
        label: runtime.config.displayName, message: 'Rotation rétablie.', active: false,
      });
    }

    // --- 8. Cohérence RPM ---
    const inconsistent = hasTach && rpmInconsistent(runtime.pwm, runtime.rpm, runtime.config.warnRpm);

    // --- 9. Gravité publiée ---
    runtime.severity = runtime.stalled || runtime.controlState === 'FAILSAFE' || runtime.controlState === 'ERROR'
      ? 'critical'
      : inconsistent || runtime.sensorLostSince !== null
        ? 'warning'
        : runtime.controlState === 'BIOS_CONTROLLED'
          ? 'unknown'
          : 'normal';
  }

  /** Relève la vitesse et **la qualifie**.
   *
   *  Une lecture manquante, non numérique ou négative n'est pas convertie en 0 :
   *  elle reste `null` avec la provenance `unavailable`. Un 0 fabriqué serait
   *  indiscernable d'un ventilateur réellement arrêté, à l'écran comme dans
   *  l'historique. Cette absence ne modifie aucune consigne : elle neutralise la
   *  détection de blocage (cf. `updateStall`) sans jamais faire monter le PWM. */
  private readRpm(runtime: OutputRuntime): void {
    if (!runtime.monitorOutputKey) {
      runtime.rpm = null;
      runtime.rpmSource = 'unavailable';
      return;
    }
    const raw = this.deps.hwmon.readRpm(runtime.monitorOutputKey);
    const valid = raw !== null && Number.isFinite(raw) && raw >= 0;
    runtime.rpm = valid ? raw : null;
    runtime.rpmSource = !valid
      ? 'unavailable'
      : this.deps.hwmon.kind === 'simulated' ? 'simulated' : 'measured';
  }

  private writePwm(runtime: OutputRuntime, pwm: number, config: AppConfig): void {
    if (!runtime.boundOutputKey) return;
    try {
      this.deps.hwmon.writePwmPercent(runtime.boundOutputKey, pwm);
      runtime.pwm = pwm;
      if (runtime.writeFailures > 0) {
        runtime.writeFailures = 0;
        runtime.lastWriteError = null;
        if (runtime.controlState === 'FAILSAFE') {
          runtime.controlState = 'SOFTWARE_CONTROLLED';
          this.emitAlert({
            type: 'PWM_WRITE_FAILED', level: 'critical', fanId: runtime.id,
            label: runtime.config.displayName, message: 'Écriture PWM rétablie.', active: false,
          });
        }
      }
    } catch (err) {
      runtime.writeFailures++;
      runtime.lastWriteError = (err as Error).message;
      log.throttled(`write-${runtime.id}`, 30_000, 'error', 'Écriture PWM en échec', {
        fanId: runtime.id, failures: runtime.writeFailures, error: (err as Error).message,
      });
      if (runtime.writeFailures >= config.fanControl.maxWriteFailures && runtime.controlState !== 'FAILSAFE') {
        runtime.controlState = 'FAILSAFE';
        this.emitAlert({
          type: 'PWM_WRITE_FAILED', level: 'critical', fanId: runtime.id,
          label: runtime.config.displayName,
          message: `Écriture PWM impossible (${runtime.writeFailures} échecs) — passage en sécurité.`,
          recommendation: 'Vérifier les permissions sysfs et l’état du contrôleur.',
          active: true,
        });
        this.emitEvent({
          category: 'fan', level: 'critical', targetLabel: runtime.config.displayName,
          message: 'Passage en mode sécurité après échecs d’écriture PWM.',
        });
        // Tentative de restitution au BIOS si elle a été validée.
        if (runtime.calibration.biosReturn === 'CONFIRMED') {
          this.returnToBios(runtime, 'échecs d’écriture PWM');
        }
      }
    }
  }

  // =====================================================================
  // Retour au BIOS
  // =====================================================================

  /** Restitue une sortie au contrôleur matériel. Le résultat est vérifié. */
  returnToBios(runtime: OutputRuntime, cause: string): boolean {
    if (!runtime.boundOutputKey) {
      runtime.controlState = 'BIOS_CONTROLLED';
      return true;
    }
    runtime.controlState = 'RETURNING_TO_BIOS';
    const biosMode = runtime.calibration.biosEnableMode ?? runtime.observedBiosMode;
    if (biosMode === null) {
      log.warn('Mode BIOS inconnu : restitution impossible', { fanId: runtime.id, cause });
      this.emitAlert({
        type: 'BIOS_RETURN_FAILED', level: 'warning', fanId: runtime.id,
        label: runtime.config.displayName,
        message: 'Mode BIOS d’origine inconnu — restitution non garantie.',
        recommendation: 'Lancer la calibration pour enregistrer le mode matériel.',
        active: true,
      });
      runtime.controlState = 'BIOS_CONTROLLED';
      return false;
    }
    try {
      this.deps.hwmon.writeEnableMode(runtime.boundOutputKey, biosMode);
      const after = this.deps.hwmon.readEnableMode(runtime.boundOutputKey);
      const ok = after === null || after === biosMode;
      runtime.controlState = 'BIOS_CONTROLLED';
      log.info('Sortie restituée au BIOS', { fanId: runtime.id, cause, mode: biosMode, verified: ok });
      this.emitEvent({
        category: 'fan', level: ok ? 'normal' : 'warning', targetLabel: runtime.config.displayName,
        message: ok ? `Sortie restituée au BIOS (${cause}).` : `Restitution au BIOS non confirmée (${cause}).`,
      });
      if (!ok) {
        this.emitAlert({
          type: 'BIOS_RETURN_FAILED', level: 'warning', fanId: runtime.id,
          label: runtime.config.displayName,
          message: 'Le pilote n’a pas confirmé le retour au mode matériel.',
          active: true,
        });
      }
      return ok;
    } catch (err) {
      runtime.controlState = 'ERROR';
      log.error('Restitution au BIOS impossible', { fanId: runtime.id, error: err });
      this.emitAlert({
        type: 'BIOS_RETURN_FAILED', level: 'critical', fanId: runtime.id,
        label: runtime.config.displayName,
        message: `Restitution au BIOS impossible : ${(err as Error).message}`,
        recommendation: 'Vérifier le pilote hwmon ; le ventilateur peut rester sur la dernière consigne.',
        active: true,
      });
      return false;
    }
  }

  // =====================================================================
  // Commandes
  // =====================================================================

  startTest(id: FanId, seconds: number): { ok: boolean; error?: string } {
    const runtime = this.outputs.get(id);
    if (!runtime) return { ok: false, error: 'Sortie inconnue' };
    if (runtime.controlState !== 'SOFTWARE_CONTROLLED') {
      return { ok: false, error: 'Sortie non pilotée par le logiciel : test impossible.' };
    }
    const clamped = Math.max(1, Math.min(120, Math.round(seconds)));
    runtime.testUntil = Date.now() + clamped * 1000;
    this.emitEvent({
      category: 'fan', level: 'normal', targetLabel: runtime.config.displayName,
      message: `Test temporaire démarré (${clamped} s à 100 %).`,
    });
    return { ok: true };
  }

  stopTest(id: FanId): { ok: boolean } {
    const runtime = this.outputs.get(id);
    if (runtime) runtime.testUntil = null;
    return { ok: true };
  }

  forceMax(id: FanId, seconds?: number): { ok: boolean; error?: string } {
    const runtime = this.outputs.get(id);
    if (!runtime) return { ok: false, error: 'Sortie inconnue' };
    if (runtime.controlState !== 'SOFTWARE_CONTROLLED') {
      return { ok: false, error: 'Sortie sous contrôle BIOS : forçage impossible.' };
    }
    runtime.forceMax = true;
    runtime.forceMaxUntil = seconds ? Date.now() + seconds * 1000 : null;
    this.emitEvent({
      category: 'fan', level: 'warning', targetLabel: runtime.config.displayName,
      message: 'Consigne forcée à 100 %.',
    });
    return { ok: true };
  }

  clearForceMax(id: FanId): void {
    const runtime = this.outputs.get(id);
    if (runtime) {
      runtime.forceMax = false;
      runtime.forceMaxUntil = null;
    }
  }

  requestReturnToBios(id: FanId): { ok: boolean; error?: string } {
    const runtime = this.outputs.get(id);
    if (!runtime) return { ok: false, error: 'Sortie inconnue' };
    const ok = this.returnToBios(runtime, 'demande explicite');
    return ok ? { ok } : { ok, error: 'Retour au BIOS non confirmé.' };
  }

  /** Reprise du contrôle logiciel après un retour BIOS manuel. */
  requestSoftwareControl(id: FanId): { ok: boolean; error?: string } {
    const runtime = this.outputs.get(id);
    if (!runtime) return { ok: false, error: 'Sortie inconnue' };
    if (runtime.calibration.state !== 'AUTHORIZED') {
      return { ok: false, error: 'Sortie non autorisée : calibration incomplète.' };
    }
    if (this.deps.config.fanControl.requireBiosReturnValidation && runtime.calibration.biosReturn !== 'CONFIRMED') {
      return { ok: false, error: 'Retour BIOS non confirmé : contrôle logiciel refusé.' };
    }
    this.evaluateControlTakeover(id);
    return runtime.controlState === 'SOFTWARE_CONTROLLED'
      ? { ok: true }
      : { ok: false, error: 'Prise de contrôle refusée.' };
  }

  /** Redécouvre le matériel et réévalue toutes les liaisons. */
  rediscover(): void {
    this.deps.hwmon.discover();
    this.deps.sensors.refreshMap();
    // Le mappage est re-résolu contre la nouvelle découverte : si les `hwmonN`
    // ont été renumérotés, les mêmes sorties physiques sont retrouvées.
    this.applyDeclaredMapping();
    this.restoreTachBindings();
    this.evaluateControlTakeover();
  }

  /** Mappage déclaratif tel qu'il a été résolu — exposé pour le diagnostic. */
  declaredMapping(): ResolvedFanMapping[] {
    return [...this.mapping.values()];
  }

  // =====================================================================
  // Accès pour l'assistant de calibration
  // =====================================================================

  runtimeFor(id: FanId): OutputRuntime | null {
    return this.outputs.get(id) ?? null;
  }

  /** Suspend la régulation d'une sortie (calibration exclusive). */
  suspend(id: FanId): void {
    const runtime = this.outputs.get(id);
    if (runtime) runtime.suspendedForCalibration = true;
  }

  resume(id: FanId): void {
    const runtime = this.outputs.get(id);
    if (!runtime) return;
    runtime.suspendedForCalibration = false;
    runtime.stall = emptyStallState();
    runtime.stalled = false;
    this.evaluateControlTakeover(id);
  }

  reloadCalibration(id: FanId): void {
    const runtime = this.outputs.get(id);
    if (!runtime) return;
    runtime.calibration = this.deps.repos.calibration.get(id);
  }

  hwmonBackend(): HwmonBackend {
    return this.deps.hwmon;
  }

  sensorSource(): SensorSource {
    return this.deps.sensors;
  }

  appConfig(): AppConfig {
    return this.deps.config;
  }

  // =====================================================================
  // Publication d'état
  // =====================================================================

  state(): FanEngineState {
    return {
      heartbeat: this.lastHeartbeat,
      pid: process.pid,
      mode: this.deps.mode,
      loopIntervalMs: this.deps.config.fanControl.loopIntervalMs,
      failsafe: [...this.outputs.values()].some((o) => o.controlState === 'FAILSAFE'),
      unconnectedOutputs: this.unconnectedState(),
      outputs: [...this.outputs.values()].map((o): FanOutputState => ({
        id: o.id,
        controlState: o.controlState,
        calibrationState: o.calibration.state,
        pwm: o.pwm,
        requestedPwm: o.requestedPwm,
        rpm: o.rpm,
        rpmSource: o.rpmSource,
        refTemp: o.refTemp,
        sensorLostSince: o.sensorLostSince,
        stalled: o.stalled,
        stalledSince: o.stall.since,
        testRemainingS: o.testUntil ? Math.max(0, Math.ceil((o.testUntil - Date.now()) / 1000)) : null,
        lastWriteError: o.lastWriteError,
        writeFailures: o.writeFailures,
        boundOutputKey: o.boundOutputKey,
        monitorOutputKey: o.monitorOutputKey,
        mappingSource: o.mappingSource,
        connectorLabel: o.connectorLabel ?? o.id,
        hwmonPath: o.monitorOutputKey
          ? this.deps.hwmon.getOutput(o.monitorOutputKey)?.pwmPath ?? null
          : null,
        severity: o.severity,
      })),
      warnings: this.warnings,
    };
  }

  private publishState(now: number): void {
    this.lastHeartbeat = now;
    this.deps.onState?.(this.state());
  }

  // =====================================================================
  // Arrêt propre
  // =====================================================================

  /** Consigne sûre, restitution au BIOS, vérification, puis arrêt. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopLoop();
    const config = this.deps.config;
    log.info('Arrêt du moteur — restitution des sorties au BIOS');

    for (const runtime of this.outputs.values()) {
      if (runtime.controlState !== 'SOFTWARE_CONTROLLED'
        && runtime.controlState !== 'FAILSAFE'
        && runtime.controlState !== 'SOFTWARE_STARTING') continue;
      // 1. Consigne sûre avant restitution : le BIOS peut mettre un instant à reprendre.
      try {
        const safe = Math.max(config.fanControl.shutdownPwm, runtime.pwm);
        if (runtime.boundOutputKey) this.deps.hwmon.writePwmPercent(runtime.boundOutputKey, safe);
      } catch (err) {
        log.warn('Consigne d’arrêt non appliquée', { fanId: runtime.id, error: err });
      }
      // 2. Restitution + vérification.
      this.returnToBios(runtime, 'arrêt du service');
    }

    // 3. Laisser au contrôleur le temps de reprendre la main avant de quitter.
    await new Promise((r) => setTimeout(r, 500));
    for (const runtime of this.outputs.values()) {
      if (!runtime.boundOutputKey) continue;
      const mode = this.deps.hwmon.readEnableMode(runtime.boundOutputKey);
      const expected = runtime.calibration.biosEnableMode ?? runtime.observedBiosMode;
      if (expected !== null && mode !== null && mode !== expected) {
        log.error('Restitution au BIOS non vérifiée à l’arrêt', { fanId: runtime.id, mode, expected });
      }
    }
    log.info('Moteur arrêté');
  }

  private emitEvent(e: EngineEvent): void {
    this.deps.onEvent?.(e);
  }

  private emitAlert(a: EngineAlert): void {
    this.deps.onAlert?.(a);
  }
}
