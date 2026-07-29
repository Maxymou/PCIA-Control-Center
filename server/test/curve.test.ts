/** Courbes : validation stricte et interpolation.
 *
 *  L'interpolation doit être identique à celle du front-end (`src/utils/curve.ts`)
 *  pour que l'aperçu affiché corresponde à la consigne réellement appliquée.
 */

import { describe, expect, it } from 'vitest';
import { applyFloor, evalCurve, validateCurve } from '../src/fan/curve.js';
import { evalCurve as evalCurveFrontend } from '../../src/utils/curve.js';

describe('validateCurve', () => {
  it('accepte une courbe minimale de deux points', () => {
    const result = validateCurve([{ temp: 40, pwm: 30 }, { temp: 80, pwm: 100 }]);
    expect(result.ok).toBe(true);
    expect(result.curve).toEqual([{ temp: 40, pwm: 30 }, { temp: 80, pwm: 100 }]);
  });

  it('refuse moins de deux points', () => {
    const result = validateCurve([{ temp: 40, pwm: 30 }]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/au moins 2 points/);
  });

  it('refuse plus de six points', () => {
    const points = Array.from({ length: 7 }, (_, i) => ({ temp: 20 + i * 10, pwm: i * 10 }));
    const result = validateCurve(points);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/dépasser 6 points/);
  });

  it('trie les points par température', () => {
    const result = validateCurve([{ temp: 80, pwm: 100 }, { temp: 40, pwm: 30 }]);
    expect(result.ok).toBe(true);
    expect(result.curve![0].temp).toBe(40);
  });

  it('refuse deux points à la même température', () => {
    const result = validateCurve([{ temp: 50, pwm: 30 }, { temp: 50, pwm: 60 }]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/même température/);
  });

  it('refuse une puissance décroissante avec la température', () => {
    const result = validateCurve([{ temp: 40, pwm: 90 }, { temp: 50, pwm: 80 }]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/non décroissante/);
  });

  it('refuse une puissance hors bornes', () => {
    expect(validateCurve([{ temp: 40, pwm: -5 }, { temp: 50, pwm: 60 }]).ok).toBe(false);
    expect(validateCurve([{ temp: 40, pwm: 30 }, { temp: 50, pwm: 140 }]).ok).toBe(false);
  });

  it('refuse une valeur non numérique', () => {
    expect(validateCurve([{ temp: 'chaud', pwm: 30 }, { temp: 50, pwm: 60 }]).ok).toBe(false);
    expect(validateCurve('pas une courbe').ok).toBe(false);
    expect(validateCurve(null).ok).toBe(false);
  });

  it('accepte un palier plat (puissance constante)', () => {
    expect(validateCurve([{ temp: 40, pwm: 50 }, { temp: 80, pwm: 50 }]).ok).toBe(true);
  });
});

describe('evalCurve', () => {
  const curve = [{ temp: 40, pwm: 30 }, { temp: 50, pwm: 50 }];

  it('interpole linéairement entre deux points', () => {
    // Exemple du cahier des charges : 40 °C → 30 %, 50 °C → 50 %, donc 45 °C → 40 %.
    expect(evalCurve(curve, 45)).toBe(40);
  });

  it('plafonne aux extrémités', () => {
    expect(evalCurve(curve, 10)).toBe(30);
    expect(evalCurve(curve, 99)).toBe(50);
  });

  it('donne exactement le même résultat que l’interpolation du front-end', () => {
    const complex = [
      { temp: 30, pwm: 20 }, { temp: 50, pwm: 35 }, { temp: 70, pwm: 65 }, { temp: 85, pwm: 100 },
    ];
    for (let t = 0; t <= 110; t += 0.5) {
      expect(evalCurve(complex, t)).toBeCloseTo(evalCurveFrontend(complex, t), 9);
    }
  });

  it('renvoie 0 pour une courbe vide plutôt que de lever une erreur', () => {
    expect(evalCurve([], 50)).toBe(0);
  });

  it('reste défini pour une température non numérique', () => {
    expect(evalCurve(curve, Number.NaN)).toBe(50);
  });
});

describe('applyFloor', () => {
  it('relève les points sous le plancher sans toucher aux autres', () => {
    const floored = applyFloor([{ temp: 30, pwm: 12 }, { temp: 80, pwm: 90 }], 35);
    expect(floored).toEqual([{ temp: 30, pwm: 35 }, { temp: 80, pwm: 90 }]);
  });
});
