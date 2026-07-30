/** Agrégation des capteurs et association capteur → emplacement. */

import { describe, expect, it } from 'vitest';
import type { DiscoveredTempSensor, HardwareId, SensorRef } from '../src/contract.js';
import { autoMapSensors, resolveSensorMap } from '../src/hardware/sensors.js';
import { resolveRefTemp } from '../src/fan/sensorSource.js';

function makeSource(values: Partial<Record<HardwareId, number | null>>, gpus: HardwareId[] = []) {
  return {
    read: (id: HardwareId) => values[id] ?? null,
    availableGpus: () => gpus,
  };
}

describe('resolveRefTemp', () => {
  it('lit un capteur unique', () => {
    const result = resolveRefTemp({ kind: 'single', source: 'cpu' }, makeSource({ cpu: 52 }));
    expect(result.value).toBe(52);
    expect(result.missing).toEqual([]);
  });

  it('signale le capteur manquant plutôt que de renvoyer 0', () => {
    // Renvoyer 0 ferait ralentir les ventilateurs : c'est exactement l'inverse
    // du comportement voulu quand on perd un capteur.
    const result = resolveRefTemp({ kind: 'single', source: 'cpu' }, makeSource({ cpu: null }));
    expect(result.value).toBeNull();
    expect(result.missing).toEqual(['cpu']);
  });

  it('retient le GPU le plus chaud', () => {
    const source = makeSource({ 'v100-1': 61, 'v100-2': 74, gtx1080: 40 }, ['v100-1', 'v100-2', 'gtx1080']);
    expect(resolveRefTemp({ kind: 'hottest-gpu' }, source).value).toBe(74);
  });

  it('renvoie null si aucun GPU n’est lisible', () => {
    const result = resolveRefTemp({ kind: 'hottest-gpu' }, makeSource({}, []));
    expect(result.value).toBeNull();
  });

  it('calcule le maximum d’une sélection en ignorant les capteurs absents', () => {
    const sensor: SensorRef = { kind: 'max', sources: ['cpu', 'v100-1', 'nvme'] };
    const result = resolveRefTemp(sensor, makeSource({ cpu: 50, 'v100-1': null, nvme: 44 }));
    expect(result.value).toBe(50);
    expect(result.missing).toEqual(['v100-1']);
  });

  it('calcule la moyenne d’une sélection', () => {
    const sensor: SensorRef = { kind: 'avg', sources: ['cpu', 'nvme'] };
    expect(resolveRefTemp(sensor, makeSource({ cpu: 50, nvme: 40 })).value).toBe(45);
  });

  it('renvoie null si toute la sélection est indisponible', () => {
    const sensor: SensorRef = { kind: 'max', sources: ['cpu', 'nvme'] };
    const result = resolveRefTemp(sensor, makeSource({ cpu: null, nvme: null }));
    expect(result.value).toBeNull();
    expect(result.missing).toEqual(['cpu', 'nvme']);
  });
});

function sensor(driver: string, label: string | null, index = 1): DiscoveredTempSensor {
  return {
    key: `${driver}:key#temp${index}`,
    controller: {
      key: `${driver}:key`, driverName: driver, kernelDriver: driver,
      bus: 'platform', address: `${driver}.0`, modalias: null, currentPath: '/sys/class/hwmon/hwmon0',
    },
    index,
    path: `/sys/class/hwmon/hwmon0/temp${index}_input`,
    label,
    valueC: 45,
    mappedTo: null,
  };
}

describe('autoMapSensors', () => {
  it('préfère coretemp « Package id 0 » pour le CPU', () => {
    const sensors = [
      sensor('coretemp', 'Core 0', 2),
      sensor('coretemp', 'Package id 0', 1),
      sensor('nct6798', 'CPUTIN', 3),
    ];
    expect(autoMapSensors(sensors).cpu).toBe(sensors[1].key);
  });

  it('retombe sur CPUTIN du Super-IO quand coretemp est absent', () => {
    const sensors = [sensor('nct6798', 'CPUTIN', 2), sensor('nct6798', 'SYSTIN', 1)];
    expect(autoMapSensors(sensors).cpu).toBe(sensors[0].key);
  });

  it('associe le NVMe et la carte mère', () => {
    const sensors = [sensor('nvme', 'Composite'), sensor('nct6798', 'SYSTIN')];
    const map = autoMapSensors(sensors);
    expect(map.nvme).toBe(sensors[0].key);
    expect(map.motherboard).toBe(sensors[1].key);
  });

  it('n’invente pas de capteur boîtier sans libellé explicite', () => {
    const map = autoMapSensors([sensor('nct6798', 'AUXTIN0')]);
    expect(map['case-front']).toBeUndefined();
    expect(map['case-rear']).toBeUndefined();
  });

  it('reconnaît un libellé de boîtier explicite', () => {
    const sensors = [sensor('nct6798', 'Rear exhaust', 4)];
    expect(autoMapSensors(sensors)['case-rear']).toBe(sensors[0].key);
  });
});

describe('resolveSensorMap', () => {
  it('donne la priorité au forçage utilisateur', () => {
    const sensors = [sensor('coretemp', 'Package id 0', 1), sensor('nct6798', 'CPUTIN', 2)];
    const { map, warnings } = resolveSensorMap(sensors, { cpu: sensors[1].key });
    expect(map.cpu).toBe(sensors[1].key);
    expect(warnings).toEqual([]);
  });

  it('ignore un forçage vers un capteur disparu et le signale', () => {
    const sensors = [sensor('coretemp', 'Package id 0', 1)];
    const { map, warnings } = resolveSensorMap(sensors, { cpu: 'capteur-disparu#temp9' });
    expect(map.cpu).toBe(sensors[0].key);
    expect(warnings).toHaveLength(1);
  });
});
