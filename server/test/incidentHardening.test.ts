/** Durcissements consécutifs à l'incident de production du 2026-08-05 :
 *
 *  - SYS_FAN1/SYS_FAN2 autorisés en contrôle logiciel au démarrage alors que
 *    leur session de calibration avait été abandonnée en cours de route ;
 *  - SYS_FAN3/SYS_FAN4 calibrés sur un pwm croisé (pwm5/pwm4 au lieu de
 *    pwm4/pwm5 déclarés) ;
 *  - pwm4/pwm5 restés en mode manuel après un arrêt sans que rien ne les
 *    restitue au BIOS ;
 *  - testRpm classait à tort en INCONSISTENT des blowers Tesla V100 dépassant
 *    12 000 RPM, alors que la réponse PWM/tach était parfaite.
 *
 *  Chaque test construit son propre environnement isolé (pas de host partagé)
 *  pour éviter toute interférence entre scénarios qui modifient délibérément
 *  la configuration (mappage déclaré, délais).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { emptyCalibration } from '../src/db/repositories.js';
import { evaluateRpmSamples } from '../src/fan/calibration.js';
import { PASSIVE_COOLING_FANS } from '../src/fan/defaults.js';
import { FanHost } from '../src/fan/host.js';
import { SIM_MODE_BIOS, SIM_MODE_MANUAL } from '../src/hwmon/simulated.js';
import { createTestEnv, sleep, waitFor, type TestEnv } from './helpers.js';

const hosts: FanHost[] = [];
const envs: TestEnv[] = [];

function makeHost(env: TestEnv, configOverrides: (config: TestEnv['config']) => void = () => {}): FanHost {
  const config = structuredClone(env.config);
  configOverrides(config);
  const host = new FanHost({
    config, repos: env.repos, hwmon: env.hwmon, mode: 'demo',
    gpuProvider: () => env.world.gpus(), withIpc: false, withStateFile: false,
  });
  hosts.push(host);
  return host;
}

function makeEnv(): TestEnv {
  const env = createTestEnv();
  envs.push(env);
  return env;
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((h) => h.stop()));
  envs.splice(0).forEach((e) => e.cleanup());
});

// =====================================================================
// Réconciliation des sorties manuelles orphelines
// =====================================================================

describe('réconciliation des sorties manuelles orphelines', () => {
  it('restitue au BIOS dès le démarrage une sortie non autorisée trouvée en mode manuel', () => {
    const env = makeEnv();
    const key = env.hwmon.outputKeyByLabel('SYS_FAN3')!;
    env.hwmon.writeEnableMode(key, SIM_MODE_MANUAL);
    env.repos.calibration.save({
      ...emptyCalibration('SYS_FAN3'),
      state: 'FAILED',
      outputKey: key,
      assignedHardware: 'v100-1',
      biosEnableMode: SIM_MODE_BIOS,
      manualEnableMode: SIM_MODE_MANUAL,
    });

    const host = makeHost(env);
    host.start();

    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);
    expect(host.state().outputs.find((o) => o.id === 'SYS_FAN3')!.controlState).toBe('BIOS_CONTROLLED');
  });

  it('restitue au BIOS pendant l’exécution (tick), pas seulement au démarrage', async () => {
    const env = makeEnv();
    const key = env.hwmon.outputKeyByLabel('SYS_FAN4')!;
    env.repos.calibration.save({
      ...emptyCalibration('SYS_FAN4'),
      state: 'RESTRICTED',
      outputKey: key,
      assignedHardware: 'v100-2',
      biosEnableMode: SIM_MODE_BIOS,
      manualEnableMode: SIM_MODE_MANUAL,
    });

    const host = makeHost(env, (c) => { c.fanControl.loopIntervalMs = 100; });
    host.start();
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);

    // Une sortie retrouvée en mode manuel en cours d'exécution (par ex. une
    // session de calibration abandonnée hors des chemins déjà couverts) doit
    // être ramenée au BIOS au prochain tick, sans intervention.
    env.hwmon.writeEnableMode(key, SIM_MODE_MANUAL);
    await waitFor(() => env.hwmon.readEnableMode(key) === SIM_MODE_BIOS, 3000, 'réconciliation en tick');
  });

  it('ne touche jamais une sortie réellement AUTHORIZED', () => {
    const env = makeEnv();
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    env.hwmon.writeEnableMode(key, SIM_MODE_MANUAL);
    env.repos.calibration.save({
      ...emptyCalibration('CPU_FAN1'),
      state: 'AUTHORIZED',
      outputKey: key,
      assignedHardware: 'cpu',
      softwareControlValidated: true,
      rpmValidation: 'CONFIRMED',
      minimumPwm: 30,
      biosReturn: 'CONFIRMED',
      biosEnableMode: SIM_MODE_BIOS,
      manualEnableMode: SIM_MODE_MANUAL,
    });

    const host = makeHost(env);
    host.start();

    // Prise de contrôle logicielle légitime : reste en mode manuel, à dessein.
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_MANUAL);
    expect(host.state().outputs.find((o) => o.id === 'CPU_FAN1')!.controlState).toBe('SOFTWARE_CONTROLLED');
  });

  // Exigé explicitement : une session active (paliers 40/70/100/50 %, comme
  // test-rpm) ne doit jamais être interrompue par la réconciliation, y
  // compris pendant les temps d'attente entre écriture PWM et lecture RPM
  // stabilisée, ni entre deux étapes utilisateur — tant que la « lease »
  // (sessionIdleTimeoutMs) n'a pas expiré. Après expiration, la restitution
  // doit avoir lieu.
  it('n’interfère jamais avec une session active en cours de test-rpm (paliers 40/70/100/50 %), et restitue après expiration de la lease', async () => {
    const env = makeEnv();
    const host = makeHost(env, (c) => {
      // Palier ~3 s (Math.max(3000, identifyStepSeconds*500)) : assez long
      // pour que de nombreux ticks (loopIntervalMs=100) surviennent entre
      // l'écriture PWM et la lecture RPM stabilisée, au sein de chaque palier.
      c.calibration.identifyStepSeconds = 2;
      c.calibration.sessionIdleTimeoutMs = 1500;
      c.fanControl.loopIntervalMs = 100;
    });
    host.start();

    const key = env.hwmon.outputKeyByLabel('SYS_FAN3')!;
    host.calibration.start('SYS_FAN3', key);
    env.repos.calibration.save({ ...env.repos.calibration.get('SYS_FAN3'), assignedHardware: 'v100-1' });
    host.calibration.testRpm('SYS_FAN3');

    // Observation pendant toute la durée des 4 paliers : la sortie appartient
    // à une session active (`suspendedForCalibration`) tout du long, y
    // compris pendant les ctx.wait() entre écriture et lecture — la
    // réconciliation ne doit jamais s'y appliquer.
    const manualSamples: boolean[] = [];
    const stepDeadline = Date.now() + 20_000;
    while (Date.now() < stepDeadline) {
      env.world.step();
      manualSamples.push(env.hwmon.readEnableMode(key) === SIM_MODE_MANUAL);
      if (host.calibration.session('SYS_FAN3')?.busy === false) break;
      await sleep(80);
    }

    expect(host.calibration.session('SYS_FAN3')?.busy).toBe(false);
    // Plusieurs dizaines de ticks moteur (loopIntervalMs=100) ont eu lieu
    // pendant les ~12 s des 4 paliers : tous confirment le mode manuel intact.
    expect(manualSamples.length).toBeGreaterThan(10);
    expect(manualSamples.every(Boolean)).toBe(true);
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_MANUAL);
    expect(['CONFIRMED', 'PROBABLE']).toContain(env.repos.calibration.get('SYS_FAN3').rpmValidation);

    // L'étape s'est terminée normalement (comme dans l'incident réel) : la
    // session reste ouverte, la sortie reste en mode manuel — c'est
    // l'intervalle normal entre deux étapes utilisateur, couvert par la lease.
    // Sans aucune interaction ensuite, une fois la lease expirée, le filet de
    // sécurité doit restituer le BIOS de lui-même.
    await waitFor(() => env.hwmon.readEnableMode(key) === SIM_MODE_BIOS, 10_000, 'restitution après expiration de la lease');
    expect(host.calibration.session('SYS_FAN3')).toBeNull();
    expect(host.state().outputs.find((o) => o.id === 'SYS_FAN3')!.controlState).toBe('BIOS_CONTROLLED');
  }, 45_000);
});

// =====================================================================
// Sessions de calibration abandonnées : filet de sécurité par expiration
// =====================================================================

describe('sessions de calibration abandonnées', () => {
  it('restitue automatiquement le BIOS après expiration, sans aucune interaction', async () => {
    const env = makeEnv();
    const host = makeHost(env, (c) => {
      c.calibration.sessionIdleTimeoutMs = 500;
      c.calibration.identifyStepSeconds = 1;
      c.fanControl.loopIntervalMs = 200;
    });
    host.start();

    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    expect(host.calibration.start('CPU_FAN1', key).ok).toBe(true);
    expect(host.calibration.identify('CPU_FAN1').ok).toBe(true);

    // L'étape se termine normalement (comme dans l'incident réel) : la sortie
    // reste en mode manuel, la session reste ouverte, mais plus personne
    // n'interagit ensuite.
    const stepDone = Date.now() + 10_000;
    while (Date.now() < stepDone) {
      env.world.step();
      if (host.calibration.session('CPU_FAN1')?.busy === false) break;
      await sleep(50);
    }
    expect(host.calibration.session('CPU_FAN1')?.busy).toBe(false);
    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_MANUAL);

    // Aucune autre interaction : le filet de sécurité doit agir seul.
    await waitFor(() => env.hwmon.readEnableMode(key) === SIM_MODE_BIOS, 10_000, 'restitution après abandon');
    expect(host.calibration.session('CPU_FAN1')).toBeNull();
    expect(host.state().outputs.find((o) => o.id === 'CPU_FAN1')!.controlState).toBe('BIOS_CONTROLLED');
  }, 30_000);

  it('ne touche jamais une session avec une étape réellement en cours (busy)', async () => {
    const env = makeEnv();
    const host = makeHost(env, (c) => {
      c.calibration.sessionIdleTimeoutMs = 500;
      c.calibration.minimumStepSeconds = 3;
      c.calibration.minimumDecrement = 20;
      c.fanControl.loopIntervalMs = 200;
    });
    host.start();

    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    // Identification déjà confirmée (hors sujet de ce test) pour que
    // detectMinimum dépasse la garde assignedHardware et reste réellement busy.
    env.repos.calibration.save({ ...env.repos.calibration.get('CPU_FAN1'), assignedHardware: 'cpu' });
    host.calibration.detectMinimum('CPU_FAN1');
    // Le timeout (500 ms) est très inférieur à la durée réelle de l'étape :
    // si le filet de sécurité l'interrompait à tort, la session disparaîtrait.
    await sleep(1500);
    env.world.step();
    expect(host.calibration.session('CPU_FAN1')).not.toBeNull();
  }, 20_000);
});

// =====================================================================
// Validation stricte fanId ↔ outputKey (config.yaml)
// =====================================================================

describe('validation stricte fanId ↔ outputKey', () => {
  const mapping = (pwm: number) => ({ controllerName: 'nct6795', pwm });

  it('refuse de démarrer une calibration sur un pwm croisé avec le mappage déclaré', () => {
    const env = makeEnv();
    const host = makeHost(env, (c) => {
      c.fans.mapping.SYS_FAN3 = mapping(4);
      c.fans.mapping.SYS_FAN4 = mapping(5);
    });
    host.start();

    // Exactement le croisement constaté en production.
    const crossedKey = env.hwmon.outputKeyByLabel('SYS_FAN4')!; // résout à pwm5
    const result = host.calibration.start('SYS_FAN3', crossedKey);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incohérente avec le mappage déclaré/);
    expect(env.repos.calibration.get('SYS_FAN3').outputKey).toBeNull();
  });

  it('accepte le pwm conforme au mappage déclaré', () => {
    const env = makeEnv();
    const host = makeHost(env, (c) => {
      c.fans.mapping.SYS_FAN3 = mapping(4);
    });
    host.start();

    const correctKey = env.hwmon.outputKeyByLabel('SYS_FAN3')!; // résout à pwm4
    expect(host.calibration.start('SYS_FAN3', correctKey).ok).toBe(true);
  });

  it('ne bloque rien quand aucun mappage n’est déclaré (comportement historique)', () => {
    const env = makeEnv();
    const host = makeHost(env); // fans.mapping vide par défaut
    host.start();
    const key = env.hwmon.outputKeyByLabel('SYS_FAN3')!;
    expect(host.calibration.start('SYS_FAN3', key).ok).toBe(true);
  });
});

// =====================================================================
// Cohérence assignedHardware (calibration) ↔ fan_configs
// =====================================================================

describe('cohérence assignedHardware ↔ fan_configs', () => {
  it('refuse l’autorisation si l’étiquette de calibration diverge de fan_configs', () => {
    const env = makeEnv();
    const host = makeHost(env);
    host.start();

    const key = env.hwmon.outputKeyByLabel('SYS_FAN1')!;
    // fan_configs déclare SYS_FAN1 = case-rear (valeur par défaut) ; on force
    // une étiquette de calibration différente, exactement l'incident réel.
    expect(env.repos.fanConfigs.get('SYS_FAN1')?.assignedHardware).toBe('case-rear');
    env.repos.calibration.save({
      ...emptyCalibration('SYS_FAN1'),
      state: 'FAILED', // pas encore authorized, pour isoler cette seule condition
      outputKey: key,
      assignedHardware: 'cpu',
      softwareControlValidated: true,
      rpmValidation: 'CONFIRMED',
      minimumPwm: 30,
      biosReturn: 'CONFIRMED',
    });

    const result = host.calibration.authorize('SYS_FAN1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/affectation matérielle incohérente/);
    expect(result.error).toMatch(/cpu/);
    expect(result.error).toMatch(/case-rear/);
  });

  it('autorise normalement quand les deux étiquettes concordent', () => {
    const env = makeEnv();
    const host = makeHost(env);
    host.start();

    const key = env.hwmon.outputKeyByLabel('SYS_FAN1')!;
    env.repos.calibration.save({
      ...emptyCalibration('SYS_FAN1'),
      state: 'FAILED',
      outputKey: key,
      assignedHardware: 'case-rear',
      softwareControlValidated: true,
      rpmValidation: 'CONFIRMED',
      minimumPwm: 30,
      biosReturn: 'CONFIRMED',
    });

    expect(host.calibration.authorize('SYS_FAN1').ok).toBe(true);
  });
});

// =====================================================================
// Seuil de plausibilité RPM — sorties de refroidissement passif
// =====================================================================

describe('plausibilité RPM pour les sorties de refroidissement passif', () => {
  it('confirme un blower Tesla dépassant 12 000 RPM avec une réponse PWM/tach conforme', async () => {
    const env = makeEnv();
    env.hwmon.setMaxRpm('SYS_FAN3', 15_340); // valeur mesurée en production
    const host = makeHost(env, (c) => { c.calibration.identifyStepSeconds = 1; });
    host.start();

    const key = env.hwmon.outputKeyByLabel('SYS_FAN3')!;
    host.calibration.start('SYS_FAN3', key);
    env.repos.calibration.save({ ...env.repos.calibration.get('SYS_FAN3'), assignedHardware: 'v100-1' });
    host.calibration.testRpm('SYS_FAN3');

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      env.world.step();
      if (host.calibration.session('SYS_FAN3')?.busy === false) break;
      await sleep(50);
    }

    const record = env.repos.calibration.get('SYS_FAN3');
    expect(['CONFIRMED', 'PROBABLE']).toContain(record.rpmValidation);
    expect(record.maxRpmObserved).toBeGreaterThan(12_000);
  }, 30_000);

  it('conserve le plafond de 12 000 RPM pour les sorties non passives', async () => {
    const env = makeEnv();
    env.hwmon.setMaxRpm('CPU_FAN1', 15_340); // valeur physiquement anormale pour un CPU_FAN1
    const host = makeHost(env, (c) => { c.calibration.identifyStepSeconds = 1; });
    host.start();

    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    env.repos.calibration.save({ ...env.repos.calibration.get('CPU_FAN1'), assignedHardware: 'cpu' });
    host.calibration.testRpm('CPU_FAN1');

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      env.world.step();
      if (host.calibration.session('CPU_FAN1')?.busy === false) break;
      await sleep(50);
    }

    expect(env.repos.calibration.get('CPU_FAN1').rpmValidation).toBe('INCONSISTENT');
  }, 30_000);
});

// =====================================================================
// Classification PASSIVE_COOLING_FANS et preuve avec les séries réelles
// =====================================================================
//
// `evaluateRpmSamples` est la fonction exacte appelée par `testRpm` (extraite
// pour être testable directement, sans dépendre des délais/du modèle physique
// du simulateur hwmon) — aucune divergence possible entre ce test et le code
// qui tourne en production.

describe('classification PASSIVE_COOLING_FANS des sorties Tesla', () => {
  it('SYS_FAN3 et SYS_FAN4 sont classées PASSIVE_COOLING_FANS — pas les autres sorties', () => {
    expect(PASSIVE_COOLING_FANS).toContain('SYS_FAN3');
    expect(PASSIVE_COOLING_FANS).toContain('SYS_FAN4');
    expect(PASSIVE_COOLING_FANS).not.toContain('CPU_FAN1');
    expect(PASSIVE_COOLING_FANS).not.toContain('SYS_FAN1');
    expect(PASSIVE_COOLING_FANS).not.toContain('SYS_FAN2');
  });

  it('le plafond passif par défaut (config de production) vaut bien 20 000 RPM', () => {
    // Config par défaut = ce que charge le serveur si config.yaml ne surcharge
    // pas la clé (packaging/config.example.yaml la fixe explicitement à 20000
    // aussi, valeur identique — voir ce fichier).
    const config = configSchema.parse({});
    expect(config.calibration.passiveRpmPlausibleMax).toBe(20_000);
  });

  it.each([
    ['SYS_FAN3', [[40, 6958], [70, 11440], [100, 15340], [50, 8881]]],
    ['SYS_FAN4', [[40, 7105], [70, 11739], [100, 15340], [50, 9060]]],
  ] as const)('%s : la série réelle mesurée en production est CONFIRMED avec le plafond passif 20 000', (fanId, series) => {
    const samples = series.map(([pwm, rpm]) => ({ pwm, rpm }));
    expect(PASSIVE_COOLING_FANS).toContain(fanId);
    const plausibleMax = PASSIVE_COOLING_FANS.includes(fanId)
      ? configSchema.parse({}).calibration.passiveRpmPlausibleMax
      : 12_000;
    expect(plausibleMax).toBe(20_000);

    const { result, minRpm, maxRpm } = evaluateRpmSamples(samples, plausibleMax);
    expect(result).toBe('CONFIRMED');
    expect(maxRpm).toBe(15_340);
    expect(minRpm).toBe(Math.min(...series.map(([, rpm]) => rpm)));
  });

  it('la même série, avec le plafond non-passif (12 000), resterait INCONSISTENT — preuve que le plafond fait la différence', () => {
    const samples = [40, 70, 100, 50].map((pwm, i) => ({
      pwm, rpm: [6958, 11440, 15340, 8881][i],
    }));
    expect(evaluateRpmSamples(samples, 20_000).result).toBe('CONFIRMED');
    expect(evaluateRpmSamples(samples, 12_000).result).toBe('INCONSISTENT');
  });
});

// =====================================================================
// monitoring_only : supervision tachymétrique seule, jamais autorisable
// =====================================================================

describe('fan_configs.monitoring_only', () => {
  it('authorize() refuse toujours une sortie monitoring_only, même parfaitement calibrée', () => {
    const env = makeEnv();
    const host = makeHost(env);
    host.start();

    env.repos.fanConfigs.upsert({ ...env.repos.fanConfigs.get('CPU_FAN1')!, monitoringOnly: true });

    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    env.repos.calibration.save({
      ...emptyCalibration('CPU_FAN1'),
      state: 'FAILED',
      outputKey: key,
      assignedHardware: 'cpu',
      softwareControlValidated: true,
      rpmValidation: 'CONFIRMED',
      minimumPwm: 30,
      biosReturn: 'CONFIRMED',
    });

    const result = host.calibration.authorize('CPU_FAN1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/supervision tachymétrique uniquement/);

    // Même en acceptant un état restreint, monitoring_only reste absolu.
    const restricted = host.calibration.authorize('CPU_FAN1', { acceptRestricted: true });
    expect(restricted.ok).toBe(false);
    expect(restricted.error).toMatch(/supervision tachymétrique uniquement/);
  });

  it('la reprise automatique du moteur refuse une sortie monitoring_only, même avec state=AUTHORIZED hérité', () => {
    const env = makeEnv();
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    env.hwmon.writeEnableMode(key, SIM_MODE_BIOS);
    env.repos.fanConfigs.upsert({ ...env.repos.fanConfigs.get('CPU_FAN1')!, monitoringOnly: true });
    // État AUTHORIZED hérité d'avant la pose de monitoring_only : ne doit
    // jamais reprendre le contrôle logiciel malgré cet état.
    env.repos.calibration.save({
      ...emptyCalibration('CPU_FAN1'),
      state: 'AUTHORIZED',
      outputKey: key,
      assignedHardware: 'cpu',
      softwareControlValidated: true,
      rpmValidation: 'CONFIRMED',
      minimumPwm: 30,
      biosReturn: 'CONFIRMED',
      biosEnableMode: SIM_MODE_BIOS,
      manualEnableMode: SIM_MODE_MANUAL,
    });

    const host = makeHost(env);
    host.start();

    expect(env.hwmon.readEnableMode(key)).toBe(SIM_MODE_BIOS);
    expect(host.state().outputs.find((o) => o.id === 'CPU_FAN1')!.controlState).toBe('BIOS_CONTROLLED');
  });

  it('une réinitialisation de calibration ne supprime jamais monitoring_only (porté par fan_configs, pas calibration)', () => {
    const env = makeEnv();
    const host = makeHost(env);
    host.start();

    env.repos.fanConfigs.upsert({ ...env.repos.fanConfigs.get('CPU_FAN1')!, monitoringOnly: true });
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    host.calibration.reset('CPU_FAN1');

    expect(env.repos.calibration.get('CPU_FAN1').state).toBe('NOT_CALIBRATED');
    expect(env.repos.fanConfigs.get('CPU_FAN1')!.monitoringOnly).toBe(true);
  });

  it('les noms, l’affectation matérielle et la courbe restent conservés — seul monitoring_only change', () => {
    const env = makeEnv();
    const before = env.repos.fanConfigs.get('CPU_FAN1')!;
    env.repos.fanConfigs.upsert({ ...before, monitoringOnly: true });
    const after = env.repos.fanConfigs.get('CPU_FAN1')!;

    expect(after.displayName).toBe(before.displayName);
    expect(after.assignedHardware).toBe(before.assignedHardware);
    expect(after.curve).toEqual(before.curve);
    expect(after.mode).toBe(before.mode);
    expect(after.monitoringOnly).toBe(true);
  });

  it('faux par défaut pour toutes les installations neuves (aucune activation automatique)', () => {
    const env = makeEnv();
    for (const cfg of env.repos.fanConfigs.list()) {
      expect(cfg.monitoringOnly).toBe(false);
    }
  });
});
