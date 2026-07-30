/** Abstraction hwmon : identité stable et scénarios de panne.
 *
 *  Ces tests couvrent explicitement les situations que le cahier des charges
 *  exige de gérer sans jamais toucher à du matériel réel.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { HwmonError, percentToRaw, rawToPercent } from '../src/hwmon/backend.js';
import { checkSocketPath } from '../src/fan/ipc.js';
import { SIM_MODE_BIOS, SIM_MODE_MANUAL, SimulatedHwmonBackend } from '../src/hwmon/simulated.js';
import { DemoWorld } from '../src/demo/world.js';

function makeBackend(): SimulatedHwmonBackend {
  const world = new DemoWorld();
  const hwmon = new SimulatedHwmonBackend();
  world.attachHwmon(hwmon);
  hwmon.discover();
  return hwmon;
}

describe('conversion sysfs', () => {
  it('convertit 0–255 en pourcentage et inversement', () => {
    expect(rawToPercent(0)).toBe(0);
    expect(rawToPercent(255)).toBe(100);
    expect(percentToRaw(0)).toBe(0);
    expect(percentToRaw(100)).toBe(255);
  });

  it('borne les valeurs hors plage', () => {
    expect(percentToRaw(-20)).toBe(0);
    expect(percentToRaw(400)).toBe(255);
    expect(rawToPercent(1000)).toBe(100);
  });
});

describe('découverte', () => {
  let hwmon: SimulatedHwmonBackend;
  beforeEach(() => { hwmon = makeBackend(); });

  it('expose contrôleurs, sorties PWM et capteurs', () => {
    const discovery = hwmon.cached();
    expect(discovery.controllers.length).toBeGreaterThanOrEqual(3);
    expect(discovery.pwmOutputs).toHaveLength(5);
    expect(discovery.tempSensors.length).toBeGreaterThan(0);
  });

  it('n’annonce jamais de modes pwm_enable supposés', () => {
    // Les modes acceptés ne sont pas énumérables via sysfs : ils doivent être
    // sondés à la calibration, pas devinés.
    for (const output of hwmon.cached().pwmOutputs) {
      expect(output.supportedEnableModes).toEqual([]);
    }
  });

  it('garde une identité stable quand les index /sys sont renumérotés', () => {
    const pathByKey = () => Object.fromEntries(
      hwmon.cached().controllers.map((c) => [c.key, c.currentPath]),
    );
    const before = hwmon.cached().pwmOutputs.map((o) => o.key).sort();
    const pathsBefore = pathByKey();

    hwmon.shuffleHwmonIndexes();

    const after = hwmon.cached().pwmOutputs.map((o) => o.key).sort();
    const pathsAfter = pathByKey();
    // Les empreintes survivent au renumérotage : c'est tout l'intérêt.
    expect(after).toEqual(before);
    // Et au moins un contrôleur a bien changé de chemin /sys.
    expect(Object.keys(pathsBefore).some((key) => pathsBefore[key] !== pathsAfter[key])).toBe(true);
  });

  it('change d’identité quand le contrôleur est remplacé', () => {
    const before = hwmon.cached().pwmOutputs.map((o) => o.key);
    hwmon.replaceController('nct6798', { driverName: 'it8686', kernelDriver: 'it87', address: 'it87.552' });
    const after = hwmon.cached().pwmOutputs.map((o) => o.key);
    expect(after.some((key) => before.includes(key))).toBe(false);
  });

  it('fait disparaître les sorties d’un contrôleur absent', () => {
    hwmon.setControllerPresent('nct6798', false);
    expect(hwmon.cached().pwmOutputs).toHaveLength(0);
    hwmon.setControllerPresent('nct6798', true);
    expect(hwmon.cached().pwmOutputs).toHaveLength(5);
  });

  it('retire une sortie absente sans casser les autres', () => {
    hwmon.removeOutput('SYS_FAN4');
    const keys = hwmon.cached().pwmOutputs.map((o) => o.label);
    expect(keys).not.toContain('SYS_FAN4');
    expect(keys).toContain('SYS_FAN3');
  });
});

describe('écriture', () => {
  let hwmon: SimulatedHwmonBackend;
  let key: string;
  beforeEach(() => {
    hwmon = makeBackend();
    key = hwmon.outputKeyByLabel('CPU_FAN1')!;
  });

  it('refuse une sortie inconnue', () => {
    expect(() => hwmon.writePwmPercent('inexistante#pwm9', 50)).toThrow(HwmonError);
  });

  it('refuse une valeur non numérique', () => {
    expect(() => hwmon.writePwmPercent(key, Number.NaN)).toThrow(HwmonError);
  });

  it('borne la consigne écrite', () => {
    hwmon.writePwmPercent(key, 480);
    expect(hwmon.readPwmPercent(key)).toBe(100);
    hwmon.writePwmPercent(key, -30);
    expect(hwmon.readPwmPercent(key)).toBe(0);
  });

  it('remonte une écriture refusée par le pilote', () => {
    hwmon.setWriteRefused('CPU_FAN1', true);
    expect(() => hwmon.writePwmPercent(key, 50)).toThrow(/refusée/);
  });

  it('refuse un mode pwm_enable non supporté', () => {
    expect(() => hwmon.writeEnableMode(key, 3)).toThrow(HwmonError);
    expect(() => hwmon.writeEnableMode(key, SIM_MODE_MANUAL)).not.toThrow();
  });
});

describe('retour tachymétrique et RPM', () => {
  let hwmon: SimulatedHwmonBackend;
  let key: string;
  beforeEach(() => {
    hwmon = makeBackend();
    key = hwmon.outputKeyByLabel('CPU_FAN1')!;
    hwmon.writeEnableMode(key, SIM_MODE_MANUAL);
  });

  it('fait varier le RPM avec la consigne', () => {
    hwmon.writePwmPercent(key, 100);
    for (let i = 0; i < 12; i++) hwmon.step(1000);
    const high = hwmon.readRpm(key)!;

    hwmon.writePwmPercent(key, 30);
    for (let i = 0; i < 12; i++) hwmon.step(1000);
    const low = hwmon.readRpm(key)!;

    expect(high).toBeGreaterThan(low * 1.5);
  });

  it('reste à zéro sous le seuil de démarrage', () => {
    hwmon.writePwmPercent(key, 0);
    for (let i = 0; i < 20; i++) hwmon.step(1000);
    expect(hwmon.readRpm(key)).toBe(0);

    // Une consigne inférieure au seuil de démarrage ne relance pas le ventilateur.
    hwmon.writePwmPercent(key, 5);
    for (let i = 0; i < 20; i++) hwmon.step(1000);
    expect(hwmon.readRpm(key)).toBe(0);
  });

  it('renvoie null quand la sortie n’a pas de tachymètre', () => {
    hwmon.setTachAvailable('CPU_FAN1', false);
    const refreshed = hwmon.outputKeyByLabel('CPU_FAN1')!;
    expect(hwmon.readRpm(refreshed)).toBeNull();
  });

  it('permet de réassocier le tachymètre après identification', () => {
    const tachs = hwmon.tachKeysForController(hwmon.getOutput(key)!.controller.key);
    expect(tachs.length).toBeGreaterThan(1);
    hwmon.bindTach(key, tachs[1].key);
    expect(hwmon.getOutput(key)!.tachIndex).toBe(tachs[1].index);
    hwmon.bindTach(key, null);
    expect(hwmon.getOutput(key)!.tachIndex).toBeNull();
  });

  it('simule un blocage mécanique : RPM nul malgré une consigne maximale', () => {
    hwmon.setStalled('CPU_FAN1', true);
    hwmon.writePwmPercent(key, 100);
    for (let i = 0; i < 15; i++) hwmon.step(1000);
    expect(hwmon.readRpm(key)).toBe(0);
  });
});

describe('mode BIOS', () => {
  it('ignore les écritures logicielles tant que le mode matériel est actif', () => {
    const hwmon = makeBackend();
    const key = hwmon.outputKeyByLabel('SYS_FAN1')!;
    expect(hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);

    hwmon.writePwmPercent(key, 0);
    for (let i = 0; i < 15; i++) hwmon.step(1000);
    // Le contrôleur applique sa propre régulation : le ventilateur tourne.
    expect(hwmon.readRpm(key)!).toBeGreaterThan(0);
  });
});

describe('capteurs', () => {
  it('renvoie null pour un capteur en panne', () => {
    const hwmon = makeBackend();
    const sensor = hwmon.cached().tempSensors.find((s) => s.label === 'CPUTIN')!;
    expect(hwmon.readTempC(sensor.key)).not.toBeNull();
    hwmon.setSensorFailed('cpu', true);
    expect(hwmon.readTempC(sensor.key)).toBeNull();
  });
});

describe('canal de commande', () => {
  it('refuse un chemin de socket que le noyau tronquerait', () => {
    // sun_path est limité à 107 octets : au-delà, le serveur écouterait sur un
    // fichier différent de celui que le client cherche.
    const long = `/tmp/${'x'.repeat(120)}/fand.sock`;
    const result = checkSocketPath(long);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/trop long/);
  });

  it('accepte le chemin d’installation standard', () => {
    expect(checkSocketPath('/run/pcia-control-center/fand.sock').ok).toBe(true);
  });
});
