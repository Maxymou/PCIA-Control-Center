/** Interface d'accès aux contrôleurs matériels.
 *
 *  Deux implémentations : `SysfsHwmonBackend` (Linux réel) et
 *  `SimulatedHwmonBackend` (mode démo + tests). Le moteur de ventilation et
 *  l'assistant de calibration ne connaissent que cette interface — aucun chemin
 *  /sys n'apparaît ailleurs dans le code.
 *
 *  Règles non négociables imposées ici :
 *   - une écriture PWM n'est acceptée que sur une sortie **connue et
 *     inscriptible**, jamais sur un chemin fourni par un client ;
 *   - la valeur est bornée à 0–100 % avant conversion ;
 *   - toute erreur d'écriture remonte (elle ne doit jamais être avalée).
 */

import type { DiscoveredPwmOutput, DiscoveredTempSensor, HwmonDiscovery } from '../contract.js';

export class HwmonError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'NOT_WRITABLE' | 'IO' | 'INVALID' | 'UNSUPPORTED') {
    super(message);
    this.name = 'HwmonError';
  }
}

export interface HwmonBackend {
  readonly kind: 'sysfs' | 'simulated';

  /** (Re)parcourt les contrôleurs. À appeler au démarrage et sur rafraîchissement
   *  explicite : les index /sys peuvent changer entre deux redémarrages. */
  discover(): HwmonDiscovery;

  /** Dernière découverte, sans re-parcourir le système. */
  cached(): HwmonDiscovery;

  getOutput(key: string): DiscoveredPwmOutput | null;
  getTempSensor(key: string): DiscoveredTempSensor | null;

  /** Consigne courante en % (0–100), null si illisible. */
  readPwmPercent(key: string): number | null;

  /** Écrit une consigne en % (0–100). Lève `HwmonError` en cas d'échec. */
  writePwmPercent(key: string, percent: number): void;

  readEnableMode(key: string): number | null;

  /** Change le mode de pwmN_enable (1 = manuel sur la plupart des pilotes). */
  writeEnableMode(key: string, mode: number): void;

  /** RPM de l'entrée tachymétrique associée à la sortie, null si absente. */
  readRpm(key: string): number | null;

  /** RPM d'une entrée tachymétrique quelconque, par sa clé. */
  readRpmByTachKey(tachKey: string): number | null;

  /** Toutes les entrées tachymétriques du contrôleur d'une sortie donnée
   *  — utilisé par la calibration pour trouver le vrai tachymètre. */
  tachKeysForController(controllerKey: string): { key: string; index: number; path: string }[];

  readTempC(sensorKey: string): number | null;

  /** Associe (ou dissocie) une entrée tachymétrique à une sortie PWM après
   *  confirmation par la calibration. */
  bindTach(outputKey: string, tachKey: string | null): void;
}

/** Conversion sysfs : les pilotes exposent 0–255. */
export function rawToPercent(raw: number): number {
  return Math.max(0, Math.min(100, Math.round((raw / 255) * 100)));
}

export function percentToRaw(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.max(0, Math.min(255, Math.round((clamped / 100) * 255)));
}

/** Découverte vide — utilisée quand aucun contrôleur n'est accessible. */
export function emptyDiscovery(warnings: string[] = []): HwmonDiscovery {
  return { controllers: [], pwmOutputs: [], tempSensors: [], orphanTachs: [], warnings };
}
