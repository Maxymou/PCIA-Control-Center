/** Courbes de ventilation : validation stricte et interpolation.
 *
 *  L'interpolation reproduit exactement `src/utils/curve.ts` côté front-end
 *  (segments droits) afin que l'aperçu affiché et la consigne réellement
 *  appliquée coïncident.
 *
 *  La validation est *obligatoire côté serveur* : une courbe invalide est
 *  refusée et la dernière courbe valide est conservée.
 */

import type { CurvePoint, FanCurve } from '../contract.js';

export const CURVE_MIN_POINTS = 2;
export const CURVE_MAX_POINTS = 6;
export const CURVE_TEMP_MIN = 0;
export const CURVE_TEMP_MAX = 120;

export interface CurveValidation {
  ok: boolean;
  errors: string[];
  /** Courbe normalisée (arrondie, triée) quand `ok` est vrai. */
  curve: FanCurve | null;
}

/** Valide une courbe reçue de l'extérieur. Aucune correction silencieuse :
 *  seul l'arrondi et le tri sont appliqués, toute incohérence est rejetée. */
export function validateCurve(input: unknown): CurveValidation {
  const errors: string[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, errors: ['La courbe doit être un tableau de points.'], curve: null };
  }
  if (input.length < CURVE_MIN_POINTS) {
    errors.push(`Une courbe doit comporter au moins ${CURVE_MIN_POINTS} points.`);
  }
  if (input.length > CURVE_MAX_POINTS) {
    errors.push(`Une courbe ne peut pas dépasser ${CURVE_MAX_POINTS} points.`);
  }

  const points: CurvePoint[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') {
      errors.push(`Point ${i + 1} : format invalide.`);
      continue;
    }
    const temp = Number(raw.temp);
    const pwm = Number(raw.pwm);
    if (!Number.isFinite(temp)) {
      errors.push(`Point ${i + 1} : température invalide.`);
      continue;
    }
    if (!Number.isFinite(pwm)) {
      errors.push(`Point ${i + 1} : puissance invalide.`);
      continue;
    }
    if (temp < CURVE_TEMP_MIN || temp > CURVE_TEMP_MAX) {
      errors.push(`Point ${i + 1} : température hors bornes (${CURVE_TEMP_MIN}–${CURVE_TEMP_MAX} °C).`);
      continue;
    }
    if (pwm < 0 || pwm > 100) {
      errors.push(`Point ${i + 1} : puissance hors bornes (0–100 %).`);
      continue;
    }
    points.push({ temp: Math.round(temp), pwm: Math.round(pwm) });
  }

  if (errors.length > 0) return { ok: false, errors, curve: null };

  const sorted = [...points].sort((a, b) => a.temp - b.temp);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].temp === sorted[i - 1].temp) {
      errors.push(`Deux points partagent la même température (${sorted[i].temp} °C).`);
    }
    if (sorted[i].pwm < sorted[i - 1].pwm) {
      errors.push(
        `La puissance doit être non décroissante avec la température (${sorted[i - 1].temp} °C → ${sorted[i - 1].pwm} %, ` +
        `puis ${sorted[i].temp} °C → ${sorted[i].pwm} %).`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors, curve: null };
  return { ok: true, errors: [], curve: sorted };
}

/** Interpolation linéaire par segments. Identique au front-end. */
export function evalCurve(curve: FanCurve, temp: number): number {
  if (!curve || curve.length === 0) return 0;
  if (!Number.isFinite(temp)) return curve[curve.length - 1].pwm;
  if (temp <= curve[0].temp) return curve[0].pwm;
  const last = curve[curve.length - 1];
  if (temp >= last.temp) return last.pwm;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (temp >= a.temp && temp <= b.temp) {
      const ratio = b.temp === a.temp ? 0 : (temp - a.temp) / (b.temp - a.temp);
      return a.pwm + ratio * (b.pwm - a.pwm);
    }
  }
  return last.pwm;
}

/** Force un plancher sur toute la courbe (ex. ventilateur de GPU passif). */
export function applyFloor(curve: FanCurve, floorPwm: number): FanCurve {
  return curve.map((p) => ({ temp: p.temp, pwm: Math.max(p.pwm, floorPwm) }));
}

export function curvesEqual(a: FanCurve, b: FanCurve): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.temp === b[i].temp && p.pwm === b[i].pwm);
}
