/** Valeurs par défaut de la ventilation : sorties logiques et profils prédéfinis.
 *
 *  Prudence délibérée : les sorties destinées aux Tesla V100 (cartes *passives*,
 *  sans ventilateur intégré) ne descendent jamais à 0 % et gardent un plancher
 *  élevé dans tous les profils, y compris « Silencieux ».
 */

import type { FanConfig, FanCurve, FanId, FanProfile } from '../contract.js';
import { FAN_IDS } from '../contract.js';
import { applyFloor } from './curve.js';

/** Sorties refroidissant du matériel passif : plancher non négociable. */
export const PASSIVE_COOLING_FANS: FanId[] = ['SYS_FAN3', 'SYS_FAN4'];

/** Plancher minimal absolu imposé aux sorties ci-dessus, quel que soit le profil. */
export const PASSIVE_FLOOR_PWM = 35;

const curveSilent: FanCurve = [
  { temp: 30, pwm: 12 }, { temp: 55, pwm: 25 }, { temp: 75, pwm: 55 }, { temp: 90, pwm: 100 },
];
const curveBalanced: FanCurve = [
  { temp: 30, pwm: 20 }, { temp: 50, pwm: 35 }, { temp: 70, pwm: 65 }, { temp: 85, pwm: 100 },
];
const curvePerformance: FanCurve = [
  { temp: 25, pwm: 35 }, { temp: 50, pwm: 55 }, { temp: 65, pwm: 80 }, { temp: 80, pwm: 100 },
];
const curveMaxCooling: FanCurve = [
  { temp: 20, pwm: 70 }, { temp: 60, pwm: 100 },
];

function buildProfileCurves(base: FanCurve): Record<FanId, FanCurve> {
  const out = {} as Record<FanId, FanCurve>;
  for (const id of FAN_IDS) {
    out[id] = PASSIVE_COOLING_FANS.includes(id)
      ? applyFloor(structuredClone(base), PASSIVE_FLOOR_PWM)
      : structuredClone(base);
  }
  return out;
}

export const BUILTIN_PROFILE_IDS = ['p-silent', 'p-balanced', 'p-perf', 'p-max'] as const;
export const DEFAULT_PROFILE_ID = 'p-balanced';

export function builtinProfiles(): FanProfile[] {
  return [
    { id: 'p-silent', name: 'Silencieux', builtin: true, curves: buildProfileCurves(curveSilent) },
    { id: 'p-balanced', name: 'Équilibré', builtin: true, curves: buildProfileCurves(curveBalanced) },
    { id: 'p-perf', name: 'Performance', builtin: true, curves: buildProfileCurves(curvePerformance) },
    { id: 'p-max', name: 'Refroidissement maximal', builtin: true, curves: buildProfileCurves(curveMaxCooling) },
  ];
}

/** Attributions initiales — configurables, jamais déduites du seul index PWM. */
export function defaultFanConfigs(): FanConfig[] {
  const balanced = builtinProfiles().find((p) => p.id === DEFAULT_PROFILE_ID)!;
  return [
    {
      id: 'CPU_FAN1', displayName: 'Ventirad CPU', assignedHardware: 'cpu',
      sensor: { kind: 'single', source: 'cpu' }, mode: 'auto',
      manualPwm: 40, minPwm: 15, warnRpm: 300, curve: balanced.curves.CPU_FAN1,
      // Par défaut false pour toute installation : passer une sortie en
      // supervision seule est une constatation matérielle propre à une
      // machine donnée, jamais une valeur générique livrée par défaut.
      monitoringOnly: false,
    },
    // SYS_FAN1 = arrière et SYS_FAN2 = avant : c'est l'inverse de ce que
    // suggèrent les numéros, et c'est ce que le BIOS de la carte confirme.
    // L'extraction arrière suit le CPU ; l'admission avant alimente les GPU et
    // suit donc le plus chaud d'entre eux.
    {
      id: 'SYS_FAN1', displayName: 'Boîtier arrière', assignedHardware: 'case-rear',
      sensor: { kind: 'single', source: 'cpu' }, mode: 'auto',
      manualPwm: 40, minPwm: 15, warnRpm: 250, curve: balanced.curves.SYS_FAN1,
      monitoringOnly: false,
    },
    {
      id: 'SYS_FAN2', displayName: 'Boîtier avant', assignedHardware: 'case-front',
      sensor: { kind: 'hottest-gpu' }, mode: 'auto',
      manualPwm: 40, minPwm: 15, warnRpm: 250, curve: balanced.curves.SYS_FAN2,
      monitoringOnly: false,
    },
    {
      id: 'SYS_FAN3', displayName: 'Flux PCIe 1 — Tesla V100 n°1', assignedHardware: 'v100-1',
      sensor: { kind: 'single', source: 'v100-1' }, mode: 'auto',
      manualPwm: 55, minPwm: PASSIVE_FLOOR_PWM, warnRpm: 400, curve: balanced.curves.SYS_FAN3,
      monitoringOnly: false,
    },
    {
      id: 'SYS_FAN4', displayName: 'Flux PCIe 2 — Tesla V100 n°2', assignedHardware: 'v100-2',
      sensor: { kind: 'single', source: 'v100-2' }, mode: 'auto',
      manualPwm: 55, minPwm: PASSIVE_FLOOR_PWM, warnRpm: 400, curve: balanced.curves.SYS_FAN4,
      monitoringOnly: false,
    },
  ];
}

/** Plancher effectif d'une sortie : jamais en dessous du plancher de sécurité. */
export function effectiveMinPwm(fanId: FanId, configuredMin: number): number {
  return PASSIVE_COOLING_FANS.includes(fanId)
    ? Math.max(configuredMin, PASSIVE_FLOOR_PWM)
    : Math.max(0, Math.min(100, configuredMin));
}
