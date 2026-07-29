/** Moteur de ventilation : transitions d'état et sécurités.
 *
 *  Tous les tests tournent sur le backend hwmon simulé : aucun accès à du
 *  matériel réel, conformément à l'exigence du cahier des charges.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FanEngineState, FanId } from '../src/contract.js';
import { FanHost } from '../src/fan/host.js';
import { emptyCalibration } from '../src/db/repositories.js';
import { SIM_MODE_BIOS, SIM_MODE_MANUAL } from '../src/hwmon/simulated.js';
import { calibrateAll, createTestEnv, sleep, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let host: FanHost | null = null;

function buildHost(overrides: Partial<TestEnv['config']['fanControl']> = {}): FanHost {
  const config = structuredClone(env.config);
  Object.assign(config.fanControl, overrides);
  return new FanHost({
    config,
    repos: env.repos,
    hwmon: env.hwmon,
    mode: 'demo',
    gpuProvider: () => env.world.gpus(),
    // Ni socket ni fichier d'état : on teste le moteur, pas l'IPC.
    withIpc: false,
    withStateFile: false,
  });
}

function outputOf(state: FanEngineState, id: FanId) {
  return state.outputs.find((o) => o.id === id)!;
}

beforeEach(() => {
  env = createTestEnv();
});

afterEach(async () => {
  if (host) {
    await host.stop();
    host = null;
  }
  env.cleanup();
});

describe('démarrage', () => {
  it('laisse toutes les sorties au BIOS sans calibration', () => {
    host = buildHost();
    expect(host.start().started).toBe(true);
    for (const output of host.state().outputs) {
      expect(output.controlState).toBe('BIOS_CONTROLLED');
      expect(output.boundOutputKey).toBeNull();
    }
  });

  it('n’écrit aucune consigne tant qu’il est sous contrôle BIOS', () => {
    host = buildHost();
    const before = env.hwmon.writeCount;
    host.start();
    expect(env.hwmon.writeCount).toBe(before);
  });

  it('prend le contrôle logiciel une fois la calibration autorisée', () => {
    calibrateAll(env);
    host = buildHost();
    host.start();
    for (const output of host.state().outputs) {
      expect(output.controlState).toBe('SOFTWARE_CONTROLLED');
      expect(output.boundOutputKey).not.toBeNull();
    }
  });

  it('refuse le contrôle logiciel si le retour BIOS n’est pas confirmé', () => {
    calibrateAll(env);
    const record = env.repos.calibration.get('CPU_FAN1');
    env.repos.calibration.save({ ...record, biosReturn: 'NOT_CONFIRMED' });

    host = buildHost();
    host.start();
    expect(outputOf(host.state(), 'CPU_FAN1').controlState).toBe('BIOS_CONTROLLED');
    // Les autres sorties, elles, sont bien prises en charge.
    expect(outputOf(host.state(), 'SYS_FAN1').controlState).toBe('SOFTWARE_CONTROLLED');
  });

  it('autorise le contrôle sans retour BIOS confirmé si l’exigence est levée', () => {
    calibrateAll(env);
    const record = env.repos.calibration.get('CPU_FAN1');
    env.repos.calibration.save({ ...record, biosReturn: 'PROBABLE' });

    host = buildHost({ requireBiosReturnValidation: false });
    host.start();
    expect(outputOf(host.state(), 'CPU_FAN1').controlState).toBe('SOFTWARE_CONTROLLED');
  });

  it('invalide la calibration quand la sortie a disparu', () => {
    calibrateAll(env);
    env.hwmon.removeOutput('SYS_FAN4');

    host = buildHost();
    host.start();
    expect(outputOf(host.state(), 'SYS_FAN4').controlState).toBe('BIOS_CONTROLLED');
    expect(env.repos.calibration.get('SYS_FAN4').invalidatedReason).toMatch(/introuvable/);
  });

  it('invalide la calibration quand le contrôleur a été remplacé', () => {
    calibrateAll(env);
    env.hwmon.replaceController('nct6798', { driverName: 'it8686', kernelDriver: 'it87', address: 'it87.552' });

    host = buildHost();
    host.start();
    for (const output of host.state().outputs) {
      expect(output.controlState).toBe('BIOS_CONTROLLED');
    }
  });

  it('invalide la calibration après un changement de noyau', () => {
    calibrateAll(env);
    const record = env.repos.calibration.get('CPU_FAN1');
    env.repos.calibration.save({ ...record, kernelVersion: '5.15.0-inexistant' });

    host = buildHost();
    host.start();
    expect(outputOf(host.state(), 'CPU_FAN1').controlState).toBe('BIOS_CONTROLLED');
    expect(env.repos.calibration.get('CPU_FAN1').invalidatedReason).toMatch(/[Nn]oyau/);
  });

  it('reste sous contrôle BIOS si la sortie n’est pas inscriptible', () => {
    calibrateAll(env);
    // Une sortie non inscriptible ne doit jamais passer sous contrôle logiciel.
    env.hwmon.setWritable('SYS_FAN2', false);

    host = buildHost();
    host.start();
    expect(outputOf(host.state(), 'SYS_FAN2').controlState).toBe('BIOS_CONTROLLED');
  });

  it('refuse de démarrer si un autre moteur détient le verrou', () => {
    calibrateAll(env);
    host = buildHost();
    expect(host.start().started).toBe(true);

    const second = buildHost();
    const attempt = second.start();
    expect(attempt.started).toBe(false);
    expect(attempt.heldBy).toBe(process.pid);
  });
});

describe('régulation', () => {
  it('applique la courbe et fait tourner les ventilateurs', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 500 });
    host.start();

    await waitFor(() => {
      env.world.step();
      const output = outputOf(host!.state(), 'CPU_FAN1');
      return output.pwm > 0 && (output.rpm ?? 0) > 0;
    }, 8000, 'ventilateur en rotation');

    const output = outputOf(host.state(), 'CPU_FAN1');
    expect(output.refTemp).not.toBeNull();
    expect(output.pwm).toBeGreaterThanOrEqual(env.repos.fanConfigs.get('CPU_FAN1')!.minPwm);
  });

  it('respecte le plancher des sorties de cartes passives', async () => {
    calibrateAll(env);
    // Consigne manuelle nulle : elle ne doit pas arrêter le flux des V100.
    const config = env.repos.fanConfigs.get('SYS_FAN3')!;
    env.repos.fanConfigs.upsert({ ...config, mode: 'manual', manualPwm: 0 });

    host = buildHost({ loopIntervalMs: 300 });
    host.start();
    await sleep(800);

    expect(outputOf(host.state(), 'SYS_FAN3').pwm).toBeGreaterThanOrEqual(env.config.fanControl.passiveGpuFloorPwm);
  });

  it('conserve la dernière courbe valide si une courbe invalide est enregistrée', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 300 });
    host.start();
    await sleep(500);

    // Écriture directe en base d'une courbe décroissante (contourne l'API).
    const config = env.repos.fanConfigs.get('CPU_FAN1')!;
    env.repos.fanConfigs.upsert({ ...config, curve: [{ temp: 40, pwm: 90 }, { temp: 30, pwm: 95 }] });
    await sleep(700);

    // Le moteur continue de réguler : il n'est pas tombé et n'a pas mis 0 %.
    const output = outputOf(host.state(), 'CPU_FAN1');
    expect(output.controlState).toBe('SOFTWARE_CONTROLLED');
    expect(output.pwm).toBeGreaterThan(0);
  });

  it('force 100 % quand le ventilateur est bloqué', async () => {
    calibrateAll(env);
    host = buildHost({
      loopIntervalMs: 200,
      stall: { pwmThreshold: 20, delayMs: 400, consecutiveReads: 2 },
    });
    host.start();
    env.hwmon.setStalled('SYS_FAN4', true);

    await waitFor(() => {
      env.world.step();
      return outputOf(host!.state(), 'SYS_FAN4').stalled;
    }, 8000, 'détection du blocage');

    // Le blocage est constaté après l'écriture du cycle courant : la consigne
    // de sécurité est appliquée au cycle suivant.
    await waitFor(() => outputOf(host!.state(), 'SYS_FAN4').pwm === 100, 4000, 'consigne de sécurité');

    const output = outputOf(host.state(), 'SYS_FAN4');
    expect(output.pwm).toBe(100);
    expect(output.severity).toBe('critical');

    const alerts = env.repos.alerts.listActive().filter((a) => a.type === 'FAN_STALLED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].targetId).toBe('SYS_FAN4');
  });

  it('ne signale pas un blocage quand la consigne est faible', async () => {
    calibrateAll(env);
    const config = env.repos.fanConfigs.get('SYS_FAN1')!;
    env.repos.fanConfigs.upsert({ ...config, mode: 'manual', manualPwm: 0, minPwm: 0 });

    host = buildHost({ loopIntervalMs: 200, stall: { pwmThreshold: 30, delayMs: 300, consecutiveReads: 2 } });
    host.start();
    env.hwmon.setStalled('SYS_FAN1', true);
    await sleep(1500);

    expect(outputOf(host.state(), 'SYS_FAN1').stalled).toBe(false);
    expect(env.repos.alerts.listActive().some((a) => a.type === 'FAN_STALLED')).toBe(false);
  });

  it('passe en FAILSAFE après des échecs d’écriture répétés', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 200, maxWriteFailures: 2 });
    host.start();
    await sleep(400);

    env.hwmon.setWriteRefused('SYS_FAN2', true);
    // Le pilote refuse aussi le changement de mode : la restitution au BIOS
    // échoue et la sortie termine en ERROR — c'est le pire cas, et il doit
    // rester visible plutôt que silencieux.
    await waitFor(
      () => ['FAILSAFE', 'BIOS_CONTROLLED', 'ERROR'].includes(outputOf(host!.state(), 'SYS_FAN2').controlState),
      8000,
      'passage en sécurité',
    );

    const alerts = env.repos.alerts.listActive().filter((a) => a.type === 'PWM_WRITE_FAILED');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].level).toBe('critical');
    expect(outputOf(host.state(), 'SYS_FAN2').lastWriteError).toMatch(/refus/i);
  });

  it('applique la vitesse de secours quand le capteur de référence disparaît', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 200, sensorFailurePwm: 85, sensorGraceMs: 60_000 });
    host.start();
    await sleep(400);

    env.hwmon.setSensorFailed('cpu', true);
    await waitFor(() => {
      env.world.step();
      return outputOf(host!.state(), 'CPU_FAN1').sensorLostSince !== null;
    }, 8000, 'perte de capteur');

    await sleep(400);
    expect(outputOf(host.state(), 'CPU_FAN1').pwm).toBeGreaterThanOrEqual(85);
    expect(env.repos.alerts.listActive().some((a) => a.type === 'SENSOR_UNAVAILABLE')).toBe(true);
  });
});

describe('commandes', () => {
  it('refuse un test sur une sortie sous contrôle BIOS', async () => {
    host = buildHost();
    host.start();
    const result = await host.handleCommand('startTest', { fanId: 'CPU_FAN1', seconds: 5 }) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('exécute un test temporaire à 100 %', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 200 });
    host.start();

    const result = await host.handleCommand('startTest', { fanId: 'CPU_FAN1', seconds: 3 }) as { ok: boolean };
    expect(result.ok).toBe(true);
    await sleep(500);
    const output = outputOf(host.state(), 'CPU_FAN1');
    expect(output.pwm).toBe(100);
    expect(output.testRemainingS).toBeGreaterThan(0);

    await host.handleCommand('stopTest', { fanId: 'CPU_FAN1' });
    await sleep(400);
    expect(outputOf(host.state(), 'CPU_FAN1').pwm).toBeLessThan(100);
  });

  it('rejette une durée de test hors bornes', async () => {
    calibrateAll(env);
    host = buildHost();
    host.start();
    await expect(host.handleCommand('startTest', { fanId: 'CPU_FAN1', seconds: 9999 })).rejects.toThrow();
  });

  it('rejette une sortie inconnue', async () => {
    host = buildHost();
    host.start();
    await expect(host.handleCommand('startTest', { fanId: 'SYS_FAN9' })).rejects.toThrow(/inconnue/i);
  });

  it('restitue une sortie au BIOS sur demande', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 200 });
    host.start();
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_MANUAL);

    const result = await host.handleCommand('returnToBios', { fanId: 'CPU_FAN1' }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);
    expect(outputOf(host.state(), 'CPU_FAN1').controlState).toBe('BIOS_CONTROLLED');
  });
});

describe('arrêt', () => {
  it('restitue toutes les sorties au BIOS', async () => {
    calibrateAll(env);
    host = buildHost({ loopIntervalMs: 200 });
    host.start();
    await sleep(400);

    const keys = ['CPU_FAN1', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4']
      .map((label) => env.hwmon.outputKeyByLabel(label)!);
    expect(keys.every((k) => env.hwmon.readEnableMode(k) === SIM_MODE_MANUAL)).toBe(true);

    await host.stop();
    host = null;

    expect(keys.every((k) => env.hwmon.readEnableMode(k) === SIM_MODE_BIOS)).toBe(true);
  });

  it('libère le verrou pour permettre un redémarrage', async () => {
    calibrateAll(env);
    host = buildHost();
    host.start();
    await host.stop();
    host = null;

    const restarted = buildHost();
    expect(restarted.start().started).toBe(true);
    await restarted.stop();
  });
});

describe('reprise après redémarrage', () => {
  it('retrouve la sortie calibrée malgré un renumérotage des index /sys', async () => {
    calibrateAll(env);
    const first = buildHost();
    first.start();
    const boundBefore = outputOf(first.state(), 'CPU_FAN1').boundOutputKey;
    // Le verrou doit être libéré avant qu'un nouveau moteur puisse démarrer.
    await first.stop();

    // Simule un redémarrage : les index changent, pas le matériel.
    env.hwmon.shuffleHwmonIndexes();

    host = buildHost();
    host.start();
    const output = outputOf(host.state(), 'CPU_FAN1');
    expect(output.boundOutputKey).toBe(boundBefore);
    expect(output.controlState).toBe('SOFTWARE_CONTROLLED');
  });

  it('reste au BIOS quand la calibration n’a jamais été faite', async () => {
    // Une sortie non calibrée ne doit jamais passer automatiquement sous
    // contrôle logiciel, même si le matériel le permettrait.
    env.repos.calibration.save({ ...emptyCalibration('CPU_FAN1'), state: 'NOT_CALIBRATED' });
    host = buildHost();
    host.start();
    expect(outputOf(host.state(), 'CPU_FAN1').controlState).toBe('BIOS_CONTROLLED');
  });
});
