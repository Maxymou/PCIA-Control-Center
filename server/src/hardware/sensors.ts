/** Rattachement des capteurs hwmon aux emplacements logiques du front-end.
 *
 *  Aucune correspondance n'est codée en dur sur un chemin : on part des
 *  *pilotes* et des *labels* exposés, et l'utilisateur peut toujours forcer une
 *  association (persistée), qui reste prioritaire.
 */

import type { DiscoveredTempSensor, HardwareId } from '../contract.js';

/** Emplacements de température exploités par l'interface (hors GPU, lus via nvidia-smi). */
export const MAPPABLE_SENSOR_TARGETS: HardwareId[] = ['cpu', 'nvme', 'motherboard', 'case-front', 'case-rear'];

interface Candidate {
  sensor: DiscoveredTempSensor;
  score: number;
}

/** Pilotes fiables pour la température CPU, par ordre de préférence. */
const CPU_DRIVERS = ['coretemp', 'k10temp', 'zenpower', 'k8temp'];
const SUPERIO_DRIVERS = /^(nct\d+|it\d+|f7\d+|w83\d+|smsc\d+|sch\d+)/i;

function labelScore(label: string | null, patterns: { re: RegExp; score: number }[]): number {
  if (!label) return 0;
  for (const p of patterns) if (p.re.test(label)) return p.score;
  return 0;
}

/** Propose une association capteur → emplacement, avec un score de confiance. */
export function autoMapSensors(sensors: DiscoveredTempSensor[]): Partial<Record<HardwareId, string>> {
  const byTarget: Partial<Record<HardwareId, Candidate>> = {};

  const consider = (target: HardwareId, sensor: DiscoveredTempSensor, score: number) => {
    if (score <= 0) return;
    const current = byTarget[target];
    if (!current || score > current.score) byTarget[target] = { sensor, score };
  };

  for (const s of sensors) {
    const driver = s.controller.driverName.toLowerCase();
    const label = s.label;

    // --- CPU ---
    const cpuDriverIndex = CPU_DRIVERS.indexOf(driver);
    if (cpuDriverIndex >= 0) {
      // « Package id 0 » est la température paquet ; les « Core N » sont secondaires.
      const bonus = labelScore(label, [
        { re: /package/i, score: 40 },
        { re: /tctl|tdie/i, score: 35 },
        { re: /^core \d+$/i, score: 10 },
      ]);
      consider('cpu', s, 100 - cpuDriverIndex * 5 + bonus);
    } else if (SUPERIO_DRIVERS.test(driver)) {
      // Repli : le Super-IO expose souvent CPUTIN.
      consider('cpu', s, labelScore(label, [{ re: /cputin|cpu temp/i, score: 45 }]));
    }

    // --- NVMe ---
    if (driver === 'nvme') {
      consider('nvme', s, labelScore(label, [{ re: /composite/i, score: 60 }]) || 50);
    }

    // --- Carte mère ---
    if (SUPERIO_DRIVERS.test(driver)) {
      consider('motherboard', s, labelScore(label, [
        { re: /systin|system|mb temp|motherboard/i, score: 60 },
        { re: /auxtin/i, score: 20 },
      ]));
    } else if (driver === 'acpitz') {
      consider('motherboard', s, 15);
    }

    // --- Boîtier : uniquement si un label explicite existe ---
    consider('case-front', s, labelScore(label, [{ re: /front|intake/i, score: 50 }]));
    consider('case-rear', s, labelScore(label, [{ re: /rear|exhaust|back/i, score: 50 }]));
  }

  const out: Partial<Record<HardwareId, string>> = {};
  for (const [target, cand] of Object.entries(byTarget) as [HardwareId, Candidate][]) {
    out[target] = cand.sensor.key;
  }
  return out;
}

/** Fusionne l'association automatique et les forçages utilisateur.
 *  Un forçage vers un capteur disparu est ignoré (et signalé). */
export function resolveSensorMap(
  sensors: DiscoveredTempSensor[],
  overrides: Partial<Record<HardwareId, string>>,
): { map: Partial<Record<HardwareId, string>>; warnings: string[] } {
  const auto = autoMapSensors(sensors);
  const known = new Set(sensors.map((s) => s.key));
  const warnings: string[] = [];
  const map: Partial<Record<HardwareId, string>> = { ...auto };
  for (const [target, key] of Object.entries(overrides) as [HardwareId, string][]) {
    if (!key) continue;
    if (known.has(key)) {
      map[target] = key;
    } else {
      warnings.push(`Capteur forcé introuvable pour ${target} (${key}) — association automatique conservée.`);
    }
  }
  return { map, warnings };
}

/** Applique le champ `mappedTo` sur la découverte, pour l'affichage/diagnostic. */
export function annotateSensors(
  sensors: DiscoveredTempSensor[],
  map: Partial<Record<HardwareId, string>>,
): DiscoveredTempSensor[] {
  const reverse = new Map<string, HardwareId>();
  for (const [target, key] of Object.entries(map) as [HardwareId, string][]) {
    if (key) reverse.set(key, target);
  }
  return sensors.map((s) => ({ ...s, mappedTo: reverse.get(s.key) ?? null }));
}
