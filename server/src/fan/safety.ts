/** Sécurités du moteur de ventilation.
 *
 *  Politique **fail-safe** : en cas de doute, on ventile davantage.
 *  Ces fonctions sont pures et testables — la décision est séparée de l'action.
 */

import type { AppConfig } from '../config.js';
import type { FanId } from '../contract.js';

export type SafetyReason =
  | 'none'
  | 'sensor-temporarily-lost'
  | 'sensor-permanently-lost'
  | 'critical-temperature'
  | 'fan-stalled'
  | 'write-failure'
  | 'not-calibrated'
  | 'invalid-curve';

export interface SafetyDecision {
  /** Consigne imposée, ou `null` si la régulation normale s'applique. */
  forcedPwm: number | null;
  reason: SafetyReason;
  /** Une alerte doit-elle être levée ? */
  alert: 'none' | 'warning' | 'critical';
  message: string | null;
}

export const NO_SAFETY: SafetyDecision = { forcedPwm: null, reason: 'none', alert: 'none', message: null };

export interface SensorState {
  /** Depuis quand la mesure est indisponible (null = mesure valide). */
  lostSince: number | null;
}

/** Décision liée à la disponibilité du capteur de référence. */
export function sensorSafety(state: SensorState, config: AppConfig, now: number): SafetyDecision {
  if (state.lostSince === null) return NO_SAFETY;
  const elapsed = now - state.lostSince;
  if (elapsed >= config.fanControl.sensorGraceMs) {
    return {
      forcedPwm: config.fanControl.criticalPwm,
      reason: 'sensor-permanently-lost',
      alert: 'critical',
      message: 'Capteur de référence durablement indisponible — consigne de sécurité maximale.',
    };
  }
  return {
    forcedPwm: config.fanControl.sensorFailurePwm,
    reason: 'sensor-temporarily-lost',
    alert: 'warning',
    message: 'Capteur de référence temporairement indisponible — vitesse de secours appliquée.',
  };
}

/** Décision liée à une température critique. */
export function temperatureSafety(refTemp: number | null, config: AppConfig): SafetyDecision {
  if (refTemp === null) return NO_SAFETY;
  if (refTemp >= config.alerts.criticalTemperatureC) {
    return {
      forcedPwm: 100,
      reason: 'critical-temperature',
      alert: 'critical',
      // Message volontairement constant : il sert de clé de déduplication des
      // alertes. La valeur mesurée est transportée à part.
      message: 'Température de référence critique — consigne forcée à 100 %.',
    };
  }
  return NO_SAFETY;
}

// ---------------------------------------------------------------------
// Détection de ventilateur bloqué
// ---------------------------------------------------------------------

export interface StallState {
  /** Lectures consécutives à 0 RPM avec une consigne significative. */
  zeroReads: number;
  /** Début de la condition (null si aucune). */
  since: number | null;
  /** Alerte déjà levée pour cet épisode. */
  reported: boolean;
}

export function emptyStallState(): StallState {
  return { zeroReads: 0, since: null, reported: false };
}

export interface StallInput {
  pwm: number;
  rpm: number | null;
  /** La sortie possède-t-elle un retour tachymétrique exploitable ? */
  hasTach: boolean;
  /** La détection est-elle activée pour cette sortie ? */
  enabled: boolean;
}

export interface StallResult {
  state: StallState;
  stalled: boolean;
  /** Vrai uniquement au cycle où l'alerte doit être créée. */
  justDetected: boolean;
}

/** Un RPM nul ne suffit pas : il faut une consigne significative, une durée et
 *  plusieurs lectures consécutives — sinon un ventilateur volontairement arrêté
 *  déclencherait une alerte à chaque cycle. */
export function updateStall(
  prev: StallState,
  input: StallInput,
  config: AppConfig,
  now: number,
): StallResult {
  const { pwmThreshold, delayMs, consecutiveReads } = config.fanControl.stall;

  if (!input.enabled || !input.hasTach || input.rpm === null) {
    return { state: emptyStallState(), stalled: false, justDetected: false };
  }
  if (input.pwm < pwmThreshold || input.rpm > 0) {
    return { state: emptyStallState(), stalled: false, justDetected: false };
  }

  const since = prev.since ?? now;
  const zeroReads = prev.zeroReads + 1;
  const stalled = zeroReads >= consecutiveReads && now - since >= delayMs;
  const justDetected = stalled && !prev.reported;
  return {
    state: { zeroReads, since, reported: prev.reported || stalled },
    stalled,
    justDetected,
  };
}

/** Cohérence RPM/PWM : un RPM très bas alors que la consigne est haute. */
export function rpmInconsistent(pwm: number, rpm: number | null, warnRpm: number): boolean {
  if (rpm === null || rpm === 0) return false;
  return pwm > 40 && rpm < warnRpm;
}

/** Plancher effectif d'une sortie, sécurités comprises. */
export function applyLimits(params: {
  fanId: FanId;
  requestedPwm: number;
  minPwm: number;
  /** Plancher imposé aux ventilateurs de matériel passif. */
  hardFloor: number;
  /** Autoriser l'arrêt complet (consigne 0 explicite en mode manuel). */
  allowStop: boolean;
}): number {
  const { requestedPwm, minPwm, hardFloor, allowStop } = params;
  let pwm = Math.max(0, Math.min(100, Math.round(requestedPwm)));
  if (pwm === 0 && allowStop && hardFloor === 0) return 0;
  pwm = Math.max(pwm, minPwm, hardFloor);
  return Math.max(0, Math.min(100, pwm));
}
