/** Assistant de calibration guidée.
 *
 *  Aucune sortie ne devient `AUTHORIZED` sans avoir traversé les étapes
 *  nécessaires. Chaque étape :
 *   - mémorise l'état initial avant toute écriture (§16.2) ;
 *   - peut être interrompue immédiatement (arrêt d'urgence) ;
 *   - restaure l'état initial en cas d'annulation ou d'échec ;
 *   - s'interrompt d'elle-même si la température dépasse le seuil d'abandon.
 *
 *  Le moteur suspend sa régulation sur la sortie testée : deux écrivains
 *  simultanés sur le même PWM sont impossibles.
 */

import type {
  BiosReturnResult, CalibrationRecord, CalibrationState, DiscoveredPwmOutput,
  FanId, HardwareId, HwmonDiscovery, RpmValidationResult,
} from '../contract.js';
import { createLogger } from '../logger.js';
import { HwmonError } from '../hwmon/backend.js';
import { readSystemInfo } from '../system/info.js';
import type { FanEngine } from './engine.js';
import { MANUAL_ENABLE_MODE } from './engine.js';
import { PASSIVE_COOLING_FANS } from './defaults.js';

const log = createLogger('fan.calibration');

export type CalibrationStep =
  | 'idle' | 'identify' | 'test-rpm' | 'detect-minimum'
  | 'test-software-control' | 'test-bios-return';

export interface TachObservation {
  tachKey: string;
  tachIndex: number;
  /** RPM au palier bas puis au palier haut. */
  rpmLow: number | null;
  rpmHigh: number | null;
  /** Écart relatif — sert à identifier le tachymètre réellement lié. */
  delta: number;
}

export interface CalibrationSession {
  fanId: FanId;
  outputKey: string;
  step: CalibrationStep;
  busy: boolean;
  startedAt: number;
  /** Progression 0–1 de l'étape en cours. */
  progress: number;
  message: string;
  /** État sauvegardé avant toute écriture — cible de la restauration. */
  initial: {
    enableMode: number | null;
    pwmPercent: number | null;
    rpm: number | null;
    refTemp: number | null;
    savedAt: number;
  };
  lastObservations: TachObservation[];
  lastError: string | null;
  /** Résultat de la dernière étape, à afficher dans l'assistant. */
  lastResult: Record<string, unknown> | null;
}

export interface CalibrationDeps {
  engine: FanEngine;
  repos: import('../db/repositories.js').Repositories;
  onUpdate?: (fanId: FanId) => void;
}

export class CalibrationController {
  private sessions = new Map<FanId, CalibrationSession>();
  private aborts = new Map<FanId, boolean>();
  /** Étapes différées encore en vol, par sortie. Aucune ne rejette jamais. */
  private running = new Map<FanId, Promise<void>>();
  /** Réveils des attentes en cours : permet d'interrompre un palier sans délai. */
  private pendingWaits = new Set<() => void>();
  /** Arrêt demandé : plus aucune étape ne démarre. */
  private closing = false;
  /** Arrêt terminé : la base peut être fermée, plus aucun accès n'est tenté. */
  private closed = false;

  constructor(private deps: CalibrationDeps) {}

  /** Attente interruptible : `shutdown()` la réveille immédiatement au lieu de
   *  laisser un timer survivre à la fermeture de la base. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: { timer?: ReturnType<typeof setTimeout> } = {};
      const done = () => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.pendingWaits.delete(done);
        resolve();
      };
      entry.timer = setTimeout(done, ms);
      this.pendingWaits.add(done);
    });
  }

  // =====================================================================
  // Découverte
  // =====================================================================

  /** Inventaire brut, sans aucune prise de contrôle (§16.1). */
  discover(): HwmonDiscovery & { records: CalibrationRecord[] } {
    this.deps.engine.rediscover();
    const discovery = this.deps.engine.hwmonBackend().cached();
    return { ...discovery, records: this.deps.repos.calibration.list() };
  }

  sessionsList(): CalibrationSession[] {
    return [...this.sessions.values()];
  }

  session(fanId: FanId): CalibrationSession | null {
    return this.sessions.get(fanId) ?? null;
  }

  // =====================================================================
  // Session
  // =====================================================================

  /** Ouvre une session sur une sortie PWM et mémorise son état initial. */
  start(fanId: FanId, outputKey: string): { ok: boolean; error?: string; session?: CalibrationSession } {
    if (this.sessions.has(fanId)) return { ok: false, error: 'Une calibration est déjà en cours pour cette sortie.' };
    const hwmon = this.deps.engine.hwmonBackend();
    const output = hwmon.getOutput(outputKey);
    if (!output) return { ok: false, error: 'Sortie PWM inconnue.' };
    if (!output.writable) return { ok: false, error: 'Sortie PWM non inscriptible : calibration impossible.' };

    // Connecteur déclaré non raccordé : refusé d'emblée. La calibration fait
    // monter la sortie à 100 % pour identifier le ventilateur — inutile et
    // trompeur sur un connecteur dont on sait qu'il ne pilote rien.
    const unconnectedLabel = this.deps.engine.unconnectedLabelFor(outputKey);
    if (unconnectedLabel) {
      return {
        ok: false,
        error: `${unconnectedLabel} est déclaré non branché dans la configuration : calibration refusée.`,
      };
    }

    // Une seule sortie calibrée à la fois : le RPM observé doit être attribuable.
    if ([...this.sessions.values()].some((s) => s.busy)) {
      return { ok: false, error: 'Une autre calibration est en cours.' };
    }
    // Empêche d'attribuer la même sortie physique à deux sorties logiques.
    const conflict = this.deps.repos.calibration.list()
      .find((r) => r.fanId !== fanId && r.outputKey === outputKey && r.state !== 'NOT_CALIBRATED');
    if (conflict) {
      return { ok: false, error: `Cette sortie PWM est déjà attribuée à ${conflict.fanId}.` };
    }

    const runtime = this.deps.engine.runtimeFor(fanId);
    const session: CalibrationSession = {
      fanId,
      outputKey,
      step: 'idle',
      busy: false,
      startedAt: Date.now(),
      progress: 0,
      message: 'Session ouverte. État initial mémorisé.',
      initial: {
        enableMode: safe(() => hwmon.readEnableMode(outputKey)),
        pwmPercent: safe(() => hwmon.readPwmPercent(outputKey)),
        rpm: safe(() => hwmon.readRpm(outputKey)),
        refTemp: runtime?.refTemp ?? null,
        savedAt: Date.now(),
      },
      lastObservations: [],
      lastError: null,
      lastResult: null,
    };
    this.sessions.set(fanId, session);
    this.aborts.set(fanId, false);
    this.deps.engine.suspend(fanId);

    const record = this.deps.repos.calibration.get(fanId);
    this.saveRecord({
      ...record,
      state: record.state === 'NOT_CALIBRATED' ? 'DETECTED' : record.state,
      outputKey,
      controllerKey: output.controller.key,
      controllerDriver: output.controller.driverName,
      controllerAddress: output.controller.address,
      pwmIndex: output.index,
      lastPwmPath: output.pwmPath,
      lastTachPath: output.tachPath,
      biosEnableMode: record.biosEnableMode ?? session.initial.enableMode,
      invalidatedReason: null,
    });

    log.info('Calibration démarrée', { fanId, outputKey, initial: session.initial });
    this.notify(fanId);
    return { ok: true, session };
  }

  /** Annule : restaure l'état initial exact (mode + consigne). */
  async cancel(fanId: FanId): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(fanId);
    if (!session) return { ok: false, error: 'Aucune calibration en cours.' };
    this.aborts.set(fanId, true);
    await this.restoreInitial(session, 'annulation');
    this.sessions.delete(fanId);
    this.aborts.delete(fanId);
    this.deps.engine.reloadCalibration(fanId);
    this.deps.engine.resume(fanId);
    this.notify(fanId);
    return { ok: true };
  }

  /** Arrêt d'urgence : consigne sûre immédiate puis restauration. */
  async emergencyStop(fanId: FanId): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(fanId);
    if (!session) return { ok: false, error: 'Aucune calibration en cours.' };
    this.aborts.set(fanId, true);
    const hwmon = this.deps.engine.hwmonBackend();
    // Sécurité d'abord : on ventile au maximum avant toute autre action.
    try {
      hwmon.writePwmPercent(session.outputKey, 100);
    } catch (err) {
      log.error('Arrêt d’urgence : écriture 100 % impossible', { fanId, error: err });
    }
    session.message = 'Arrêt d’urgence : consigne portée à 100 %, restauration en cours.';
    this.notify(fanId);
    await this.sleep(500);
    await this.restoreInitial(session, 'arrêt d’urgence');
    this.sessions.delete(fanId);
    this.aborts.delete(fanId);
    this.deps.engine.reloadCalibration(fanId);
    this.deps.engine.resume(fanId);
    this.notify(fanId);
    return { ok: true };
  }

  /** Restaure l'état PWM mémorisé à l'ouverture de la session.
   *
   *  Ne rejette jamais : cette méthode est appelée depuis des chemins différés
   *  (échec d'étape, arrêt du service) où un rejet deviendrait un
   *  `unhandledRejection`. La lecture en base est incluse dans le `try` : après
   *  `shutdown()` la connexion SQLite peut être fermée, et la restitution
   *  matérielle doit malgré tout être tentée. */
  private async restoreInitial(session: CalibrationSession, cause: string): Promise<void> {
    const hwmon = this.deps.engine.hwmonBackend();
    try {
      if (session.initial.pwmPercent !== null) {
        hwmon.writePwmPercent(session.outputKey, session.initial.pwmPercent);
      }
      if (session.initial.enableMode !== null) {
        hwmon.writeEnableMode(session.outputKey, session.initial.enableMode);
      } else if (!this.closed) {
        const record = this.deps.repos.calibration.get(session.fanId);
        if (record.biosReturn === 'CONFIRMED' && record.biosEnableMode !== null) {
          // Mode initial inconnu : retour BIOS si celui-ci a été validé.
          hwmon.writeEnableMode(session.outputKey, record.biosEnableMode);
        }
      }
      log.info('État initial restauré', { fanId: session.fanId, cause });
    } catch (err) {
      log.error('Restauration de l’état initial impossible', { fanId: session.fanId, cause, error: err });
    }
  }

  // =====================================================================
  // Arrêt propre
  // =====================================================================

  /** Termine proprement toute calibration en cours **avant** la fermeture de la
   *  base et l'arrêt du moteur.
   *
   *  1. interrompt les étapes différées et réveille leurs attentes ;
   *  2. attend leur terminaison effective ;
   *  3. restaure l'état PWM initial de chaque session encore ouverte ;
   *  4. interdit tout accès ultérieur à la base.
   *
   *  Appelée par `FanHost.stop()`. Sans cela, un callback différé pouvait
   *  reprendre la main après `db.close()` et produire un rejet non géré
   *  (« The database connection is not open »). */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    for (const fanId of this.sessions.keys()) this.aborts.set(fanId, true);

    // Les étapes peuvent enchaîner une courte attente après leur réveil : on
    // relance le cycle réveil/attente jusqu'à ce que plus rien ne soit en vol.
    for (let pass = 0; pass < 5 && this.running.size > 0; pass++) {
      for (const wake of [...this.pendingWaits]) wake();
      await Promise.allSettled([...this.running.values()]);
    }
    if (this.running.size > 0) {
      log.warn('Étapes de calibration encore en vol à l’arrêt', { count: this.running.size });
    }

    // Restitution matérielle tant que la base est encore ouverte.
    for (const session of this.sessions.values()) {
      await this.restoreInitial(session, 'arrêt du service');
    }

    this.sessions.clear();
    this.aborts.clear();
    this.pendingWaits.clear();
    this.closed = true;
  }

  // =====================================================================
  // Étapes
  // =====================================================================

  /** §16.3 — variation contrôlée et observation de TOUS les tachymètres. */
  identify(fanId: FanId): { ok: boolean; error?: string } {
    return this.runStep(fanId, 'identify', async (session, ctx) => {
      const hwmon = this.deps.engine.hwmonBackend();
      const config = this.deps.engine.appConfig().calibration;
      const output = hwmon.getOutput(session.outputKey)!;
      const tachs = hwmon.tachKeysForController(output.controller.key);

      await this.ensureManualMode(session);

      const readAll = () => tachs.map((t) => ({ key: t.key, index: t.index, rpm: hwmon.readRpmByTachKey(t.key) }));

      // Palier bas.
      session.message = `Palier ${config.identifyLowPwm} % — observez quel ventilateur accélère.`;
      ctx.progress(0.1);
      hwmon.writePwmPercent(session.outputKey, config.identifyLowPwm);
      await ctx.wait(config.identifyStepSeconds * 1000, 0.1, 0.45);
      const low = readAll();

      // Palier haut.
      session.message = `Palier ${config.identifyHighPwm} % — observez quel ventilateur accélère.`;
      hwmon.writePwmPercent(session.outputKey, config.identifyHighPwm);
      await ctx.wait(config.identifyStepSeconds * 1000, 0.45, 0.9);
      const high = readAll();

      const observations: TachObservation[] = tachs.map((t, i) => {
        const rpmLow = low[i].rpm;
        const rpmHigh = high[i].rpm;
        const delta = rpmLow !== null && rpmHigh !== null && rpmLow > 0
          ? (rpmHigh - rpmLow) / rpmLow
          : rpmHigh !== null && rpmLow === 0 ? 1 : 0;
        return { tachKey: t.key, tachIndex: t.index, rpmLow, rpmHigh, delta };
      });
      observations.sort((a, b) => b.delta - a.delta);
      session.lastObservations = observations;
      session.lastResult = { observations, suggestedTach: observations[0]?.delta > 0.15 ? observations[0].tachKey : null };
      session.message = observations[0]?.delta > 0.15
        ? 'Un tachymètre a réagi. Confirmez le ventilateur physique concerné.'
        : 'Aucune réaction nette : le test peut être non concluant.';

      // Retour sécurisé à l'état initial du palier.
      hwmon.writePwmPercent(session.outputKey, Math.max(session.initial.pwmPercent ?? 50, 40));
      this.saveRecord({ ...this.deps.repos.calibration.get(fanId), state: 'DETECTED' });
    });
  }

  /** Confirmation utilisateur : quel ventilateur a réagi, quel tachymètre retenir. */
  confirmIdentification(
    fanId: FanId,
    input: { assignedHardware: HardwareId | 'none' | 'custom'; customLabel?: string; tachKey?: string | null; inconclusive?: boolean },
  ): { ok: boolean; error?: string } {
    const session = this.sessions.get(fanId);
    if (!session) return { ok: false, error: 'Aucune calibration en cours.' };
    if (session.busy) return { ok: false, error: 'Étape en cours.' };
    const record = this.deps.repos.calibration.get(fanId);

    if (input.inconclusive) {
      this.saveRecord({ ...record, state: 'FAILED', notes: 'Identification non concluante.' });
      session.message = 'Identification déclarée non concluante.';
      this.notify(fanId);
      return { ok: true };
    }

    const hwmon = this.deps.engine.hwmonBackend();
    const tachKey = input.tachKey ?? session.lastResult?.suggestedTach as string | undefined ?? null;
    if (tachKey) {
      const output = hwmon.getOutput(session.outputKey)!;
      const known = hwmon.tachKeysForController(output.controller.key).some((t) => t.key === tachKey);
      if (!known) return { ok: false, error: 'Tachymètre inconnu pour ce contrôleur.' };
      hwmon.bindTach(session.outputKey, tachKey);
    } else {
      hwmon.bindTach(session.outputKey, null);
    }

    const tachIndex = tachKey ? Number(tachKey.split('#fan')[1]) : null;
    this.saveRecord({
      ...record,
      state: 'IDENTIFIED',
      assignedHardware: input.assignedHardware,
      customHardwareLabel: input.customLabel ?? null,
      tachIndex,
      lastTachPath: hwmon.getOutput(session.outputKey)?.tachPath ?? null,
    });
    session.message = 'Ventilateur identifié.';
    this.notify(fanId);
    return { ok: true };
  }

  /** §16.4 — validation du retour tachymétrique. */
  testRpm(fanId: FanId): { ok: boolean; error?: string } {
    return this.runStep(fanId, 'test-rpm', async (session, ctx) => {
      const hwmon = this.deps.engine.hwmonBackend();
      const config = this.deps.engine.appConfig().calibration;
      const output = hwmon.getOutput(session.outputKey)!;
      const record = this.deps.repos.calibration.get(fanId);

      // Sans identification humaine confirmée, aucune étape suivante ne doit
      // agir sur le matériel : on ne sait pas quel ventilateur physique répond
      // réellement à cette sortie (voir `confirmIdentification`).
      if (record.assignedHardware === null) {
        session.lastError = 'Identification non confirmée : relancez l’étape « Identification physique ».';
        session.message = session.lastError;
        return;
      }

      if (output.tachPath === null) {
        session.lastResult = { result: 'NOT_AVAILABLE' as RpmValidationResult };
        session.message = 'Aucun retour tachymétrique : la sortie sera restreinte.';
        this.saveRecord({ ...record, state: 'RESTRICTED', rpmValidation: 'NOT_AVAILABLE' });
        return;
      }

      await this.ensureManualMode(session);
      const samples: { pwm: number; rpm: number | null }[] = [];
      const levels = [40, 70, 100, 50];
      for (let i = 0; i < levels.length; i++) {
        hwmon.writePwmPercent(session.outputKey, levels[i]);
        await ctx.wait(Math.max(3000, config.identifyStepSeconds * 500), i / levels.length, (i + 1) / levels.length);
        samples.push({ pwm: levels[i], rpm: hwmon.readRpm(session.outputKey) });
      }

      const valid = samples.filter((s) => s.rpm !== null) as { pwm: number; rpm: number }[];
      let result: RpmValidationResult;
      let minRpm: number | null = null;
      let maxRpm: number | null = null;

      if (valid.length < samples.length) {
        result = 'INCONSISTENT';
      } else {
        minRpm = Math.min(...valid.map((v) => v.rpm));
        maxRpm = Math.max(...valid.map((v) => v.rpm));
        const rising = valid.slice(0, 3);
        const monotonic = rising[0].rpm <= rising[1].rpm && rising[1].rpm <= rising[2].rpm;
        const spread = maxRpm > 0 ? (maxRpm - minRpm) / maxRpm : 0;
        // Un RPM plausible reste dans une plage physique crédible.
        const plausible = maxRpm > 100 && maxRpm < 12_000;
        // Le retour après changement doit se rapprocher du palier initial.
        const returned = Math.abs(valid[3].rpm - valid[0].rpm) < Math.max(200, valid[0].rpm * 0.35);
        if (!plausible) result = 'INCONSISTENT';
        else if (monotonic && spread > 0.25 && returned) result = 'CONFIRMED';
        else if (monotonic && spread > 0.1) result = 'PROBABLE';
        else result = 'INCONSISTENT';
      }

      session.lastResult = { result, samples, minRpm, maxRpm };
      session.message = `Retour RPM : ${result}.`;
      this.saveRecord({
        ...record,
        // Le cas NOT_AVAILABLE est traité plus haut (sortie sans tachymètre).
        state: result === 'CONFIRMED' || result === 'PROBABLE' ? 'RPM_CONFIRMED' : 'FAILED',
        rpmValidation: result,
        minRpmObserved: minRpm,
        maxRpmObserved: maxRpm,
      });
      hwmon.writePwmPercent(session.outputKey, Math.max(session.initial.pwmPercent ?? 50, 40));
    });
  }

  /** §16.5 — détection prudente du minimum exploitable. */
  detectMinimum(fanId: FanId): { ok: boolean; error?: string } {
    return this.runStep(fanId, 'detect-minimum', async (session, ctx) => {
      const hwmon = this.deps.engine.hwmonBackend();
      const config = this.deps.engine.appConfig().calibration;
      const record = this.deps.repos.calibration.get(fanId);

      if (record.assignedHardware === null) {
        session.lastError = 'Identification non confirmée : relancez l’étape « Identification physique ».';
        session.message = session.lastError;
        return;
      }

      const hasTach = hwmon.getOutput(session.outputKey)?.tachPath !== null;

      if (!hasTach) {
        // Sans tachymètre, aucun minimum ne peut être mesuré : on reste prudent.
        const fallback = PASSIVE_COOLING_FANS.includes(fanId) ? 40 : 30;
        session.lastResult = { minimumPwm: fallback, measured: false };
        session.message = `Sans retour RPM, un minimum prudent de ${fallback} % est retenu.`;
        this.saveRecord({ ...record, minimumPwm: fallback, notes: 'Minimum non mesuré (pas de tachymètre).' });
        return;
      }

      await this.ensureManualMode(session);
      // 1. Démarrage à une valeur sûre.
      hwmon.writePwmPercent(session.outputKey, 100);
      await ctx.wait(config.minimumStepSeconds * 1000, 0, 0.15);

      // 2. Descente progressive jusqu'à l'instabilité.
      let startupPwm: number | null = null;
      let lastRunning: number | null = null;
      const floor = PASSIVE_COOLING_FANS.includes(fanId) ? 25 : 0;
      const trace: { pwm: number; rpm: number | null }[] = [];

      for (let pwm = 100 - config.minimumDecrement; pwm >= floor; pwm -= config.minimumDecrement) {
        if (ctx.aborted()) return;
        hwmon.writePwmPercent(session.outputKey, pwm);
        await ctx.wait(config.minimumStepSeconds * 1000, 0.15 + (100 - pwm) / 100 * 0.5, 0.15 + (100 - pwm) / 100 * 0.55);
        const rpm = hwmon.readRpm(session.outputKey);
        trace.push({ pwm, rpm });
        session.message = `Descente : ${pwm} % → ${rpm ?? '—'} RPM`;
        this.notify(fanId);
        if (rpm === null || rpm === 0) {
          startupPwm = pwm + config.minimumDecrement;
          break;
        }
        lastRunning = pwm;
      }

      // 3. Remontée à une valeur sûre.
      hwmon.writePwmPercent(session.outputKey, 100);
      await ctx.wait(2000, 0.85, 0.95);

      const base = startupPwm ?? lastRunning ?? 30;
      // 4. Marge de sécurité, renforcée pour les ventilateurs de matériel passif.
      const margin = PASSIVE_COOLING_FANS.includes(fanId)
        ? config.minimumSafetyMargin * 2
        : config.minimumSafetyMargin;
      const minimum = Math.min(100, Math.max(base + margin, PASSIVE_COOLING_FANS.includes(fanId) ? 35 : 0));

      session.lastResult = { startupPwm, minimumPwm: minimum, trace, measured: true };
      session.message = `Minimum retenu : ${minimum} % (seuil observé ${base} % + marge ${margin} %).`;
      this.saveRecord({
        ...record,
        startupPwm: startupPwm ?? base,
        minimumPwm: minimum,
        minRpmObserved: trace.filter((t) => t.rpm).length
          ? Math.min(...trace.filter((t) => t.rpm).map((t) => t.rpm!))
          : record.minRpmObserved,
      });
      hwmon.writePwmPercent(session.outputKey, Math.max(session.initial.pwmPercent ?? 50, minimum));
    });
  }

  /** §16.6 — validation du contrôle logiciel. */
  testSoftwareControl(fanId: FanId): { ok: boolean; error?: string } {
    return this.runStep(fanId, 'test-software-control', async (session, ctx) => {
      const hwmon = this.deps.engine.hwmonBackend();
      const output = hwmon.getOutput(session.outputKey)!;

      // Garde avant toute prise de contrôle logiciel : voir testRpm/detectMinimum.
      if (this.deps.repos.calibration.get(fanId).assignedHardware === null) {
        session.lastError = 'Identification non confirmée : relancez l’étape « Identification physique ».';
        session.message = session.lastError;
        return;
      }

      await this.ensureManualMode(session);
      // Relu APRÈS le passage en mode manuel : cette étape enregistre les modes
      // observés, qu'il ne faut pas écraser avec une version périmée.
      const record = this.deps.repos.calibration.get(fanId);

      // Observation des autres sorties. Attention : un ventilateur resté sous
      // contrôle BIOS change légitimement de vitesse pendant le test (les
      // températures évoluent). Une variation de RPM n'est donc PAS une preuve
      // de diaphonie. Le signal fiable est la recopie de notre consigne sur le
      // registre PWM d'une autre sortie.
      const otherOutputs = hwmon.cached().pwmOutputs.filter((o) => o.key !== session.outputKey);
      const otherBefore = otherOutputs.map((o) => ({
        key: o.key,
        rpm: safe(() => hwmon.readRpm(o.key)),
        pwm: safe(() => hwmon.readPwmPercent(o.key)),
      }));

      const checks: Record<string, boolean | string> = {};
      // 1. L'écriture est-elle acceptée ?
      try {
        hwmon.writePwmPercent(session.outputKey, 60);
        await ctx.wait(4000, 0.1, 0.35);
        const readback = hwmon.readPwmPercent(session.outputKey);
        checks.writeAccepted = readback !== null && Math.abs(readback - 60) <= 3;
      } catch (err) {
        checks.writeAccepted = false;
        checks.writeError = (err as Error).message;
      }

      // 2. Le RPM suit-il ?
      const rpm60 = hwmon.readRpm(session.outputKey);
      hwmon.writePwmPercent(session.outputKey, 95);
      await ctx.wait(5000, 0.35, 0.6);
      const rpm95 = hwmon.readRpm(session.outputKey);
      checks.rpmFollows = output.tachPath === null
        ? 'non applicable'
        : rpm60 !== null && rpm95 !== null && rpm95 > rpm60 * 1.08;

      // 3. Stabilité sur un palier.
      const stability: number[] = [];
      for (let i = 0; i < 3; i++) {
        await ctx.wait(1500, 0.6 + i * 0.05, 0.65 + i * 0.05);
        const r = hwmon.readRpm(session.outputKey);
        if (r !== null) stability.push(r);
      }
      const avg = stability.length ? stability.reduce((a, b) => a + b, 0) / stability.length : 0;
      checks.stable = output.tachPath === null
        ? 'non applicable'
        : stability.length > 0 && stability.every((r) => Math.abs(r - avg) < Math.max(150, avg * 0.15));

      // 4. Diaphonie : une autre sortie a-t-elle adopté notre consigne ?
      const otherAfter = otherOutputs.map((o) => ({
        key: o.key,
        rpm: safe(() => hwmon.readRpm(o.key)),
        pwm: safe(() => hwmon.readPwmPercent(o.key)),
      }));
      const contaminated = otherBefore.filter((b, i) => {
        const a = otherAfter[i];
        if (a.pwm === null || b.pwm === null) return false;
        // La sortie voisine n'était pas à 95 % et l'est devenue : notre écriture
        // a débordé sur son registre.
        return Math.abs(b.pwm - 95) > 5 && Math.abs(a.pwm - 95) <= 3;
      });
      checks.noCrossTalk = contaminated.length === 0;
      if (contaminated.length) checks.crossTalkOutputs = contaminated.map((m) => m.key).join(', ');

      // Variation de RPM ailleurs : information, jamais un motif d'échec.
      const otherRpmMoved = otherBefore.filter((b, i) => {
        const a = otherAfter[i];
        if (b.rpm === null || a.rpm === null || b.rpm === 0) return false;
        return Math.abs(a.rpm - b.rpm) / b.rpm > 0.3;
      });
      if (otherRpmMoved.length) {
        checks.otherFansVaried = otherRpmMoved.map((m) => m.key).join(', ');
      }

      // 5. Pas de surchauffe pendant le test.
      const runtime = this.deps.engine.runtimeFor(fanId);
      checks.temperatureSafe = runtime?.refTemp === null
        || runtime === null
        || (runtime.refTemp ?? 0) < this.deps.engine.appConfig().calibration.abortTemperatureC;

      // 6. Reprise du contrôle possible.
      try {
        hwmon.writePwmPercent(session.outputKey, Math.max(session.initial.pwmPercent ?? 50, record.minimumPwm ?? 40));
        checks.recoverable = true;
      } catch {
        checks.recoverable = false;
      }

      const passed = checks.writeAccepted === true
        && checks.noCrossTalk === true
        && checks.recoverable === true
        && checks.temperatureSafe === true
        && (checks.rpmFollows === true || checks.rpmFollows === 'non applicable');

      session.lastResult = { passed, checks };
      session.message = passed
        ? 'Contrôle logiciel validé.'
        : 'Contrôle logiciel non validé — voir le détail des vérifications.';
      this.saveRecord({
        ...record,
        state: passed ? 'SOFTWARE_CONTROL_VALIDATED' : 'FAILED',
        softwareControlValidated: passed,
        manualEnableMode: record.manualEnableMode ?? MANUAL_ENABLE_MODE,
      });
    });
  }

  /** §16.7 — validation du retour BIOS. Étape obligatoire pour l'automatisme. */
  testBiosReturn(fanId: FanId): { ok: boolean; error?: string } {
    return this.runStep(fanId, 'test-bios-return', async (session, ctx) => {
      const hwmon = this.deps.engine.hwmonBackend();
      const config = this.deps.engine.appConfig().calibration;
      const output = hwmon.getOutput(session.outputKey)!;
      const sysInfo = readSystemInfo();
      let record = this.deps.repos.calibration.get(fanId);

      if (record.assignedHardware === null) {
        session.lastError = 'Identification non confirmée : relancez l’étape « Identification physique ».';
        session.message = session.lastError;
        return;
      }

      if (!output.enablePath) {
        // Sans pwm_enable, il n'existe aucun moyen de rendre la main au BIOS.
        session.lastResult = { result: 'IMPOSSIBLE' as BiosReturnResult };
        session.message = 'Le pilote n’expose pas pwm_enable : le retour BIOS est impossible.';
        this.saveRecord({ ...record, biosReturn: 'IMPOSSIBLE', state: 'RESTRICTED' });
        return;
      }

      const biosMode = record.biosEnableMode ?? session.initial.enableMode;
      if (biosMode === null) {
        session.lastResult = { result: 'UNKNOWN' as BiosReturnResult };
        session.message = 'Mode matériel d’origine inconnu : retour BIOS non vérifiable.';
        this.saveRecord({ ...record, biosReturn: 'UNKNOWN', state: 'RESTRICTED' });
        return;
      }

      // 1. Mémoriser un état logiciel volontairement distinctif.
      await this.ensureManualMode(session);
      // Relu après le passage en mode manuel, qui enregistre les modes observés.
      record = this.deps.repos.calibration.get(fanId);
      const softwarePwm = 35;
      hwmon.writePwmPercent(session.outputKey, softwarePwm);
      await ctx.wait(5000, 0.05, 0.25);
      const rpmSoftware = hwmon.readRpm(session.outputKey);
      const pwmSoftware = hwmon.readPwmPercent(session.outputKey);

      // 2. Remettre le mode matériel détecté.
      let result: BiosReturnResult;
      try {
        hwmon.writeEnableMode(session.outputKey, biosMode);
      } catch (err) {
        session.lastResult = { result: 'IMPOSSIBLE', error: (err as Error).message };
        session.message = `Le pilote refuse le retour au mode ${biosMode}.`;
        this.saveRecord({ ...record, biosReturn: 'IMPOSSIBLE', state: 'RESTRICTED' });
        return;
      }

      // 3. Observer.
      session.message = 'Retour au mode matériel : observation en cours…';
      await ctx.wait(config.biosReturnObserveSeconds * 1000, 0.25, 0.85);

      const modeAfter = hwmon.readEnableMode(session.outputKey);
      const pwmAfter = hwmon.readPwmPercent(session.outputKey);
      const rpmAfter = hwmon.readRpm(session.outputKey);

      const modeHeld = modeAfter === biosMode;
      // 4. Le système ne doit pas rester figé sur la dernière valeur logicielle.
      const pwmMoved = pwmAfter !== null && pwmSoftware !== null && Math.abs(pwmAfter - pwmSoftware) > 4;
      const rpmMoved = rpmAfter !== null && rpmSoftware !== null && rpmSoftware > 0
        && Math.abs(rpmAfter - rpmSoftware) / rpmSoftware > 0.12;

      if (!modeHeld) {
        result = 'NOT_CONFIRMED';
      } else if (pwmMoved || rpmMoved) {
        result = 'CONFIRMED';
      } else if (output.tachPath === null) {
        // Sans tachymètre, on ne peut que constater que le mode a tenu.
        result = 'PROBABLE';
      } else {
        result = 'NOT_CONFIRMED';
      }

      session.lastResult = {
        result,
        detail: { biosMode, modeAfter, pwmSoftware, pwmAfter, rpmSoftware, rpmAfter, pwmMoved, rpmMoved },
      };
      session.message = `Retour BIOS : ${result}.`;
      this.saveRecord({
        ...record,
        biosReturn: result,
        biosEnableMode: biosMode,
        state: result === 'CONFIRMED' ? 'BIOS_RETURN_VALIDATED'
          : record.state === 'SOFTWARE_CONTROL_VALIDATED' ? 'RESTRICTED' : record.state,
        biosVersion: sysInfo.biosVersion,
        kernelVersion: sysInfo.kernel,
      });
    });
  }

  /** Autorisation finale : vérifie que toutes les conditions sont réunies. */
  authorize(fanId: FanId, opts: { acceptRestricted?: boolean } = {}): { ok: boolean; error?: string; record?: CalibrationRecord } {
    const session = this.sessions.get(fanId);
    if (session?.busy) return { ok: false, error: 'Étape en cours.' };
    const record = this.deps.repos.calibration.get(fanId);
    const engineConfig = this.deps.engine.appConfig();
    const missing: string[] = [];

    if (!record.outputKey) missing.push('sortie PWM non associée');
    if (record.assignedHardware === null) missing.push('matériel non identifié');
    if (!record.softwareControlValidated) missing.push('contrôle logiciel non validé');
    if (record.rpmValidation === 'FAILED' || record.rpmValidation === 'INCONSISTENT') {
      missing.push('retour RPM incohérent');
    }
    if (record.minimumPwm === null) missing.push('minimum non déterminé');
    if (engineConfig.fanControl.requireBiosReturnValidation && record.biosReturn !== 'CONFIRMED') {
      missing.push('retour BIOS non confirmé');
    }
    if (record.invalidatedReason) missing.push(record.invalidatedReason);

    if (missing.length > 0) {
      if (opts.acceptRestricted && !missing.some((m) => m.includes('sortie PWM') || m.includes('contrôle logiciel'))) {
        const restricted: CalibrationRecord = {
          ...record, state: 'RESTRICTED', calibratedAt: Date.now(),
          notes: `Autorisation restreinte : ${missing.join(', ')}.`,
        };
        this.saveRecord(restricted);
        this.finish(fanId);
        return { ok: true, record: restricted };
      }
      return { ok: false, error: `Autorisation refusée : ${missing.join(', ')}.` };
    }

    const sysInfo = readSystemInfo();
    const authorized: CalibrationRecord = {
      ...record,
      state: 'AUTHORIZED',
      calibratedAt: Date.now(),
      biosVersion: sysInfo.biosVersion,
      kernelVersion: sysInfo.kernel,
      invalidatedReason: null,
    };
    this.saveRecord(authorized);
    this.finish(fanId);
    log.info('Sortie autorisée au contrôle logiciel', { fanId, outputKey: authorized.outputKey });
    return { ok: true, record: authorized };
  }

  /** Réinitialise complètement la calibration d'une sortie. */
  reset(fanId: FanId): void {
    this.deps.repos.calibration.reset(fanId);
    this.sessions.delete(fanId);
    this.deps.engine.reloadCalibration(fanId);
    this.deps.engine.resume(fanId);
    this.notify(fanId);
  }

  // =====================================================================
  // Utilitaires internes
  // =====================================================================

  private finish(fanId: FanId): void {
    this.sessions.delete(fanId);
    this.aborts.delete(fanId);
    this.deps.engine.reloadCalibration(fanId);
    this.deps.engine.resume(fanId);
    this.notify(fanId);
  }

  private saveRecord(record: CalibrationRecord): void {
    // Après `shutdown()`, la base peut être fermée : plus aucune écriture.
    if (this.closed) return;
    this.deps.repos.calibration.save(record);
    this.deps.engine.reloadCalibration(record.fanId);
    this.notify(record.fanId);
  }

  /** Bascule la sortie en mode manuel si nécessaire (et le mémorise). */
  private async ensureManualMode(session: CalibrationSession): Promise<void> {
    const hwmon = this.deps.engine.hwmonBackend();
    const output = hwmon.getOutput(session.outputKey);
    if (!output?.enablePath) return;
    const record = this.deps.repos.calibration.get(session.fanId);
    const current = hwmon.readEnableMode(session.outputKey);
    const manual = record.manualEnableMode ?? MANUAL_ENABLE_MODE;
    if (current === manual) return;
    hwmon.writeEnableMode(session.outputKey, manual);
    await this.sleep(300);
    const after = hwmon.readEnableMode(session.outputKey);
    if (after !== manual) {
      throw new HwmonError(`Le pilote refuse le mode manuel (lu : ${after})`, 'UNSUPPORTED');
    }
    if (record.manualEnableMode !== manual || record.biosEnableMode === null) {
      this.deps.repos.calibration.save({
        ...record,
        manualEnableMode: manual,
        biosEnableMode: record.biosEnableMode ?? current,
      });
    }
  }

  /** Enveloppe commune : exclusivité, abandon thermique, restauration en cas d'erreur. */
  private runStep(
    fanId: FanId,
    step: CalibrationStep,
    body: (session: CalibrationSession, ctx: StepContext) => Promise<void>,
  ): { ok: boolean; error?: string } {
    if (this.closing) return { ok: false, error: 'Arrêt en cours : aucune nouvelle étape.' };
    const session = this.sessions.get(fanId);
    if (!session) return { ok: false, error: 'Aucune calibration en cours pour cette sortie.' };
    if (session.busy) return { ok: false, error: 'Une étape est déjà en cours.' };

    session.busy = true;
    session.step = step;
    session.progress = 0;
    session.lastError = null;
    this.aborts.set(fanId, false);
    this.notify(fanId);

    const ctx: StepContext = {
      aborted: () => this.aborts.get(fanId) === true,
      progress: (p) => {
        session.progress = Math.max(0, Math.min(1, p));
        this.notify(fanId);
      },
      wait: async (ms, from, to) => {
        const slices = Math.max(1, Math.ceil(ms / 500));
        for (let i = 0; i < slices; i++) {
          if (this.aborts.get(fanId) || this.closing) throw new CalibrationAborted();
          this.assertThermallySafe(fanId);
          await this.sleep(Math.min(500, ms - i * 500));
          // `shutdown()` réveille l'attente sans attendre le timer : il faut
          // sortir immédiatement, avant toute nouvelle écriture ou lecture.
          if (this.aborts.get(fanId) || this.closing) throw new CalibrationAborted();
          session.progress = from + ((to - from) * (i + 1)) / slices;
          this.notify(fanId);
        }
      },
    };

    // Cette tâche différée ne doit JAMAIS rejeter : elle n'est pas attendue par
    // l'appelant, donc un rejet remonterait en `unhandledRejection` (typiquement
    // « The database connection is not open » si SQLite a été fermée entre-temps).
    const task = (async () => {
      try {
        await body(session, ctx);
      } catch (err) {
        if (err instanceof CalibrationAborted) {
          session.message = 'Étape interrompue.';
        } else {
          session.lastError = (err as Error).message;
          session.message = `Échec de l’étape : ${(err as Error).message}`;
          log.error('Étape de calibration en échec', { fanId, step, error: err });
          await this.restoreInitial(session, 'échec d’étape');
        }
      } finally {
        session.busy = false;
        session.progress = 1;
        this.notify(fanId);
      }
    })().catch((err) => {
      // Filet de sécurité : rien ne doit s'échapper de l'étape différée.
      log.error('Étape de calibration interrompue anormalement', { fanId, step, error: err });
    }).finally(() => {
      if (this.running.get(fanId) === task) this.running.delete(fanId);
    });

    this.running.set(fanId, task);
    return { ok: true };
  }

  /** Interrompt toute calibration si la température devient dangereuse. */
  private assertThermallySafe(fanId: FanId): void {
    const runtime = this.deps.engine.runtimeFor(fanId);
    const limit = this.deps.engine.appConfig().calibration.abortTemperatureC;
    const temps = this.deps.engine.sensorSource().all();
    const hottest = Math.max(runtime?.refTemp ?? 0, ...Object.values(temps).filter((v): v is number => typeof v === 'number'));
    if (hottest >= limit) {
      this.aborts.set(fanId, true);
      log.error('Calibration interrompue : température trop élevée', { fanId, hottest, limit });
      throw new Error(`Température trop élevée (${hottest.toFixed(1)} °C ≥ ${limit} °C) — calibration interrompue.`);
    }
  }

  private notify(fanId: FanId): void {
    this.deps.onUpdate?.(fanId);
  }
}

interface StepContext {
  aborted(): boolean;
  progress(p: number): void;
  wait(ms: number, from: number, to: number): Promise<void>;
}

class CalibrationAborted extends Error {
  constructor() {
    super('Étape interrompue');
    this.name = 'CalibrationAborted';
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** États pour lesquels une sortie peut être pilotée automatiquement. */
export const AUTO_CONTROL_STATES: CalibrationState[] = ['AUTHORIZED'];

/** Sorties PWM candidates pour la calibration, avec leur statut actuel. */
export function candidateOutputs(
  discovery: HwmonDiscovery,
  records: CalibrationRecord[],
): (DiscoveredPwmOutput & { assignedTo: FanId | null })[] {
  return discovery.pwmOutputs.map((o) => ({
    ...o,
    assignedTo: records.find((r) => r.outputKey === o.key && r.state !== 'NOT_CALIBRATED')?.fanId ?? null,
  }));
}
