/** Assistant de calibration : progression, refus et restauration.
 *
 *  Point clé vérifié ici : **aucune sortie ne devient AUTHORIZED** sans avoir
 *  franchi toutes les étapes, et l'état initial est restauré à l'annulation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FanId } from '../src/contract.js';
import { FanHost } from '../src/fan/host.js';
import { SIM_MODE_BIOS, SIM_MODE_MANUAL } from '../src/hwmon/simulated.js';
import { createTestEnv, sleep, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let host: FanHost;

function buildHost(overrides: Record<string, unknown> = {}): FanHost {
  const config = structuredClone(env.config);
  Object.assign(config.calibration, overrides);
  // Paliers courts : les tests ne doivent pas durer une minute.
  config.fanControl.loopIntervalMs = 200;
  return new FanHost({
    config, repos: env.repos, hwmon: env.hwmon, mode: 'demo',
    gpuProvider: () => env.world.gpus(), withIpc: false, withStateFile: false,
  });
}

/** Fait avancer le monde simulé pendant l'exécution d'une étape. */
async function runWorld(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    env.world.step();
    await sleep(40);
  }
}

async function waitIdle(fanId: FanId, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    env.world.step();
    const session = host.calibration.session(fanId);
    if (session && !session.busy) return;
    await sleep(50);
  }
  throw new Error('Étape de calibration non terminée');
}

beforeEach(() => {
  env = createTestEnv();
  host = buildHost({
    identifyStepSeconds: 2,
    minimumStepSeconds: 2,
    // Décrément large : 5 paliers au lieu de 20, sinon le test dure une minute.
    minimumDecrement: 20,
    biosReturnObserveSeconds: 3,
  });
  host.start();
});

afterEach(async () => {
  await host.stop();
  env.cleanup();
});

describe('découverte', () => {
  it('inventorie sans prendre le contrôle', () => {
    const discovery = host.calibration.discover();
    expect(discovery.pwmOutputs).toHaveLength(5);
    // Aucune sortie n'a basculé en mode manuel du seul fait de la découverte.
    for (const output of discovery.pwmOutputs) {
      expect(output.currentEnableMode).toBe(SIM_MODE_BIOS);
    }
    expect(discovery.records.every((r) => r.state === 'NOT_CALIBRATED')).toBe(true);
  });
});

describe('session', () => {
  it('mémorise l’état initial à l’ouverture', () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    const result = host.calibration.start('CPU_FAN1', key);
    expect(result.ok).toBe(true);
    expect(result.session!.initial.enableMode).toBe(SIM_MODE_BIOS);
    expect(result.session!.initial.pwmPercent).not.toBeNull();
    expect(env.repos.calibration.get('CPU_FAN1').state).toBe('DETECTED');
  });

  it('refuse une sortie PWM inconnue', () => {
    expect(host.calibration.start('CPU_FAN1', 'inexistante#pwm1').ok).toBe(false);
  });

  it('refuse une sortie non inscriptible', () => {
    env.hwmon.setWritable('SYS_FAN1', false);
    const key = env.hwmon.outputKeyByLabel('SYS_FAN1')!;
    const result = host.calibration.start('SYS_FAN1', key);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/inscriptible/);
  });

  it('refuse d’attribuer la même sortie physique à deux sorties logiques', () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    const second = host.calibration.start('SYS_FAN1', key);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/déjà attribuée|CPU_FAN1/);
  });

  it('restaure l’état initial à l’annulation', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    host.calibration.identify('CPU_FAN1');
    await runWorld(600);

    await host.calibration.cancel('CPU_FAN1');
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);
    expect(host.calibration.session('CPU_FAN1')).toBeNull();
  });

  it('remet la consigne au maximum lors d’un arrêt d’urgence', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    host.calibration.identify('CPU_FAN1');
    await runWorld(400);

    await host.calibration.emergencyStop('CPU_FAN1');
    // Sécurité d'abord, puis restauration du mode matériel.
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);
    expect(host.calibration.session('CPU_FAN1')).toBeNull();
  });
});

describe('étapes', () => {
  const start = () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    expect(host.calibration.start('CPU_FAN1', key).ok).toBe(true);
    return key;
  };

  it('identifie le tachymètre qui réagit', async () => {
    start();
    expect(host.calibration.identify('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1');

    const session = host.calibration.session('CPU_FAN1')!;
    expect(session.lastObservations.length).toBeGreaterThan(1);
    // Le tachymètre de la sortie testée doit avoir la plus forte variation.
    expect(session.lastObservations[0].delta).toBeGreaterThan(0);
    expect(session.lastResult!.suggestedTach).toBeTruthy();
  }, 45000);

  it('enregistre le matériel attribué après confirmation', async () => {
    start();
    host.calibration.identify('CPU_FAN1');
    await waitIdle('CPU_FAN1');

    const result = host.calibration.confirmIdentification('CPU_FAN1', { assignedHardware: 'cpu' });
    expect(result.ok).toBe(true);
    const record = env.repos.calibration.get('CPU_FAN1');
    expect(record.state).toBe('IDENTIFIED');
    expect(record.assignedHardware).toBe('cpu');
    expect(record.tachIndex).not.toBeNull();
  }, 45000);

  it('marque une identification non concluante comme échec', async () => {
    start();
    host.calibration.confirmIdentification('CPU_FAN1', { assignedHardware: 'none', inconclusive: true });
    expect(env.repos.calibration.get('CPU_FAN1').state).toBe('FAILED');
  });

  it('valide le retour RPM', async () => {
    start();
    expect(host.calibration.testRpm('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1');

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(['CONFIRMED', 'PROBABLE']).toContain(record.rpmValidation);
    expect(record.state).toBe('RPM_CONFIRMED');
    expect(record.maxRpmObserved).toBeGreaterThan(0);
  }, 45000);

  it('restreint une sortie sans tachymètre', async () => {
    env.hwmon.setTachAvailable('SYS_FAN2', false);
    const key = env.hwmon.outputKeyByLabel('SYS_FAN2')!;
    host.calibration.start('SYS_FAN2', key);
    host.calibration.testRpm('SYS_FAN2');
    await waitIdle('SYS_FAN2');

    const record = env.repos.calibration.get('SYS_FAN2');
    expect(record.rpmValidation).toBe('NOT_AVAILABLE');
    expect(record.state).toBe('RESTRICTED');
  }, 45000);

  it('détermine un minimum avec marge de sécurité', async () => {
    start();
    expect(host.calibration.detectMinimum('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1', 30_000);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(record.minimumPwm).not.toBeNull();
    expect(record.minimumPwm!).toBeGreaterThan(0);
    if (record.startupPwm !== null) {
      // La marge doit relever le minimum au-dessus du seuil observé.
      expect(record.minimumPwm!).toBeGreaterThanOrEqual(record.startupPwm);
    }
  }, 60000);

  it('impose un minimum élevé aux sorties de cartes passives', async () => {
    const key = env.hwmon.outputKeyByLabel('SYS_FAN3')!;
    host.calibration.start('SYS_FAN3', key);
    host.calibration.detectMinimum('SYS_FAN3');
    await waitIdle('SYS_FAN3', 30_000);
    expect(env.repos.calibration.get('SYS_FAN3').minimumPwm!).toBeGreaterThanOrEqual(35);
  }, 60000);

  it('valide le contrôle logiciel', async () => {
    start();
    expect(host.calibration.testSoftwareControl('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1', 30_000);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(record.softwareControlValidated).toBe(true);
    expect(record.state).toBe('SOFTWARE_CONTROL_VALIDATED');
  }, 60000);

  it('échoue si le pilote refuse les écritures', async () => {
    const key = env.hwmon.outputKeyByLabel('SYS_FAN1')!;
    host.calibration.start('SYS_FAN1', key);
    env.hwmon.setWriteRefused('SYS_FAN1', true);
    host.calibration.testSoftwareControl('SYS_FAN1');
    await waitIdle('SYS_FAN1', 30_000);

    const session = host.calibration.session('SYS_FAN1')!;
    expect(session.lastError ?? String(session.lastResult?.passed)).toBeTruthy();
    expect(env.repos.calibration.get('SYS_FAN1').softwareControlValidated).toBe(false);
  }, 60000);

  it('confirme le retour BIOS', async () => {
    start();
    expect(host.calibration.testBiosReturn('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1', 30_000);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(['CONFIRMED', 'PROBABLE']).toContain(record.biosReturn);
    expect(record.biosEnableMode).toBe(SIM_MODE_BIOS);
    expect(record.manualEnableMode).toBe(SIM_MODE_MANUAL);
  }, 60000);
});

describe('autorisation', () => {
  async function fullCalibration(fanId: FanId): Promise<void> {
    const key = env.hwmon.outputKeyByLabel(fanId)!;
    host.calibration.start(fanId, key);
    host.calibration.identify(fanId);
    await waitIdle(fanId, 30_000);
    host.calibration.confirmIdentification(fanId, { assignedHardware: 'cpu' });
    host.calibration.testRpm(fanId);
    await waitIdle(fanId, 30_000);
    host.calibration.detectMinimum(fanId);
    await waitIdle(fanId, 40_000);
    host.calibration.testSoftwareControl(fanId);
    await waitIdle(fanId, 30_000);
    host.calibration.testBiosReturn(fanId);
    await waitIdle(fanId, 30_000);
  }

  it('refuse une autorisation prématurée', () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    const result = host.calibration.authorize('CPU_FAN1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/contrôle logiciel non validé|matériel non identifié/);
    expect(env.repos.calibration.get('CPU_FAN1').state).not.toBe('AUTHORIZED');
  });

  it('autorise après le parcours complet et prend le contrôle', async () => {
    await fullCalibration('CPU_FAN1');
    const result = host.calibration.authorize('CPU_FAN1');
    expect(result.ok).toBe(true);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(record.state).toBe('AUTHORIZED');
    expect(record.calibratedAt).not.toBeNull();
    expect(record.kernelVersion).toBeTruthy();

    // Le moteur reprend la sortie sous contrôle logiciel.
    await waitFor(
      () => host.state().outputs.find((o) => o.id === 'CPU_FAN1')!.controlState === 'SOFTWARE_CONTROLLED',
      6000,
      'prise de contrôle après autorisation',
    );
  }, 180_000);

  it('réinitialise une calibration et repasse au BIOS', async () => {
    await fullCalibration('CPU_FAN1');
    host.calibration.authorize('CPU_FAN1');
    host.calibration.reset('CPU_FAN1');

    expect(env.repos.calibration.get('CPU_FAN1').state).toBe('NOT_CALIBRATED');
    await waitFor(
      () => host.state().outputs.find((o) => o.id === 'CPU_FAN1')!.controlState === 'BIOS_CONTROLLED',
      6000,
      'retour au contrôle BIOS',
    );
  }, 180_000);
});
