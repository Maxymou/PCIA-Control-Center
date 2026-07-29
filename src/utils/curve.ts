import type { FanCurve } from '../types';

export const TEMP_MIN = 20;
export const TEMP_MAX = 100;

/** Interpolation linéaire par segments droits sur la courbe (points triés par temp). */
export function evalCurve(curve: FanCurve, temp: number): number {
  if (curve.length === 0) return 0;
  const pts = curve;
  if (temp <= pts[0].temp) return pts[0].pwm;
  if (temp >= pts[pts.length - 1].temp) return pts[pts.length - 1].pwm;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (temp >= a.temp && temp <= b.temp) {
      const r = b.temp === a.temp ? 0 : (temp - a.temp) / (b.temp - a.temp);
      return a.pwm + r * (b.pwm - a.pwm);
    }
  }
  return pts[pts.length - 1].pwm;
}

/** Contraint un point : dans les bornes, entre ses voisins, PWM monotone croissant. */
export function clampPoint(curve: FanCurve, index: number, temp: number, pwm: number) {
  const prev = curve[index - 1];
  const next = curve[index + 1];
  const tMin = prev ? prev.temp + 1 : TEMP_MIN;
  const tMax = next ? next.temp - 1 : TEMP_MAX;
  const pMin = prev ? prev.pwm : 0;
  const pMax = next ? next.pwm : 100;
  return {
    temp: Math.round(Math.min(tMax, Math.max(tMin, temp))),
    pwm: Math.round(Math.min(pMax, Math.max(pMin, pwm))),
  };
}

export function sortCurve(curve: FanCurve): FanCurve {
  return [...curve].sort((a, b) => a.temp - b.temp);
}
