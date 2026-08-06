/** Assistant de calibration : progression, refus et restauration.
 *
 *  Point clé vérifié ici : **aucune sortie ne devient AUTHORIZED** sans avoir
 *  franchi toutes les étapes, et l'état initial est restauré à l'annulation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FanId, HardwareId } from '../src/contract.js';
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

/** Matériel plausible par sortie, pour les tests qui n'en font pas le sujet. */
const HARDWARE_FOR: Record<FanId, HardwareId> = {
  CPU_FAN1: 'cpu', SYS_FAN1: 'case-rear', SYS_FAN2: 'case-front',
  SYS_FAN3: 'v100-1', SYS_FAN4: 'v100-2',
};

/** Identification physique + confirmation, préalable désormais obligatoire à
 *  toute étape suivante (voir `describe('garde-fou identification')` plus bas).
 *
 *  `tachKey` : par défaut, laisse `confirmIdentification` retenir la
 *  suggestion de `identify()` — comportement réel de l'assistant. La passer
 *  explicitement à `null` (sortie volontairement sans tachymètre, ex. test
 *  « sans tachymètre ») évite un test intermittent : sans cela, le modèle
 *  physique simulé peut occasionnellement suggérer le tachymètre d'un *autre*
 *  ventilateur du même contrôleur et le lier à tort à cette sortie. */
async function identifyAndConfirm(fanId: FanId, opts: { tachKey?: string | null } = {}): Promise<void> {
  expect(host.calibration.identify(fanId).ok).toBe(true);
  await waitIdle(fanId);
  const result = host.calibration.confirmIdentification(fanId, {
    assignedHardware: HARDWARE_FOR[fanId],
    ...(opts.tachKey !== undefined ? { tachKey: opts.tachKey } : {}),
  });
  expect(result.ok).toBe(true);
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
    await identifyAndConfirm('CPU_FAN1');
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
    // tachKey: null explicite — voir la documentation d'identifyAndConfirm.
    await identifyAndConfirm('SYS_FAN2', { tachKey: null });
    host.calibration.testRpm('SYS_FAN2');
    await waitIdle('SYS_FAN2');

    const record = env.repos.calibration.get('SYS_FAN2');
    expect(record.rpmValidation).toBe('NOT_AVAILABLE');
    expect(record.state).toBe('RESTRICTED');
  }, 45000);

  it('détermine un minimum avec marge de sécurité', async () => {
    start();
    await identifyAndConfirm('CPU_FAN1');
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
    await identifyAndConfirm('SYS_FAN3');
    host.calibration.detectMinimum('SYS_FAN3');
    await waitIdle('SYS_FAN3', 30_000);
    expect(env.repos.calibration.get('SYS_FAN3').minimumPwm!).toBeGreaterThanOrEqual(35);
  }, 60000);

  it('valide le contrôle logiciel', async () => {
    start();
    await identifyAndConfirm('CPU_FAN1');
    expect(host.calibration.testSoftwareControl('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1', 30_000);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(record.softwareControlValidated).toBe(true);
    expect(record.state).toBe('SOFTWARE_CONTROL_VALIDATED');
  }, 60000);

  it('échoue si le pilote refuse les écritures', async () => {
    const key = env.hwmon.outputKeyByLabel('SYS_FAN1')!;
    host.calibration.start('SYS_FAN1', key);
    await identifyAndConfirm('SYS_FAN1');
    env.hwmon.setWriteRefused('SYS_FAN1', true);
    host.calibration.testSoftwareControl('SYS_FAN1');
    await waitIdle('SYS_FAN1', 30_000);

    const session = host.calibration.session('SYS_FAN1')!;
    expect(session.lastError ?? String(session.lastResult?.passed)).toBeTruthy();
    expect(env.repos.calibration.get('SYS_FAN1').softwareControlValidated).toBe(false);
  }, 60000);

  it('confirme le retour BIOS', async () => {
    start();
    await identifyAndConfirm('CPU_FAN1');
    expect(host.calibration.testBiosReturn('CPU_FAN1').ok).toBe(true);
    await waitIdle('CPU_FAN1', 30_000);

    const record = env.repos.calibration.get('CPU_FAN1');
    expect(['CONFIRMED', 'PROBABLE']).toContain(record.biosReturn);
    expect(record.biosEnableMode).toBe(SIM_MODE_BIOS);
    expect(record.manualEnableMode).toBe(SIM_MODE_MANUAL);
  }, 60000);
});

// =====================================================================
// Garde-fou : identification physique obligatoire avant toute étape agissant
// sur le matériel (régression du bouton « Confirmer le ventilateur identifié »,
// affiché uniquement à `state === 'IDENTIFIED'` — un état qu'on ne peut
// atteindre qu'en passant par ce même bouton). `assignedHardware`, pas
// `state`, fait foi : voir `authorize()` et les gardes ajoutées à testRpm,
// detectMinimum, testSoftwareControl, testBiosReturn.
// =====================================================================

describe('garde-fou identification (assignedHardware requis)', () => {
  const STEPS: [string, (fanId: FanId) => { ok: boolean; error?: string }][] = [
    ['test-rpm', (fanId) => host.calibration.testRpm(fanId)],
    ['detect-minimum', (fanId) => host.calibration.detectMinimum(fanId)],
    ['test-software-control', (fanId) => host.calibration.testSoftwareControl(fanId)],
    ['test-bios-return', (fanId) => host.calibration.testBiosReturn(fanId)],
  ];

  // Sur plusieurs sorties distinctes : le bug initial était identique pour
  // toutes les sorties, pas spécifique à l'une d'elles.
  it.each<FanId>(['SYS_FAN1', 'SYS_FAN4'])(
    'refuse test-rpm/detect-minimum/test-software-control/test-bios-return sans identification confirmée (%s)',
    async (fanId) => {
      const key = env.hwmon.outputKeyByLabel(fanId)!;
      host.calibration.start(fanId, key);
      expect(env.repos.calibration.get(fanId).assignedHardware).toBeNull();

      for (const [label, run] of STEPS) {
        const result = run(fanId);
        // La commande est acceptée (une session existe) : c'est l'étape
        // elle-même, différée, qui doit se bloquer sans toucher au matériel.
        expect(result.ok, `${label} devrait être accepté puis se bloquer`).toBe(true);
        await waitIdle(fanId);

        expect(
          host.calibration.session(fanId)!.lastError,
          `${label} devrait signaler l'absence d'identification`,
        ).toMatch(/identification non confirmée/i);
        expect(env.hwmon.readEnableMode(key), `${label} ne doit pas écrire pwm*_enable`).toBe(SIM_MODE_BIOS);
        expect(env.repos.calibration.get(fanId).assignedHardware).toBeNull();
      }

      const authResult = host.calibration.authorize(fanId);
      expect(authResult.ok).toBe(false);
      expect(authResult.error).toMatch(/matériel non identifié/);
    },
    45_000,
  );

  // Reproduit exactement l'incident constaté en production : une session déjà
  // avancée jusqu'à BIOS_RETURN_VALIDATED (par les étapes lancées hors ordre,
  // avant le correctif) sans que `confirmIdentification` n'ait jamais été
  // appelé. Le nouveau garde-fou doit bloquer ces sessions historiques, pas
  // seulement empêcher qu'on en crée de nouvelles.
  it('bloque une session historique déjà avancée jusqu’à BIOS_RETURN_VALIDATED sans identification', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);

    const record = env.repos.calibration.get('CPU_FAN1');
    env.repos.calibration.save({
      ...record,
      state: 'BIOS_RETURN_VALIDATED',
      rpmValidation: 'CONFIRMED',
      minimumPwm: 40,
      softwareControlValidated: true,
      biosReturn: 'CONFIRMED',
      assignedHardware: null, // jamais confirmé — c'est le bug reproduit
    });

    for (const [label, run] of STEPS) {
      const result = run('CPU_FAN1');
      expect(result.ok, `${label} devrait être accepté puis se bloquer`).toBe(true);
      await waitIdle('CPU_FAN1');
      expect(
        host.calibration.session('CPU_FAN1')!.lastError,
        `${label} devrait signaler l'absence d'identification`,
      ).toMatch(/identification non confirmée/i);
      expect(env.hwmon.readEnableMode(key), `${label} ne doit pas écrire pwm*_enable`).toBe(SIM_MODE_BIOS);
      // L'état incohérent n'a pas été aggravé par la tentative.
      expect(env.repos.calibration.get('CPU_FAN1').state).toBe('BIOS_RETURN_VALIDATED');
    }

    const authResult = host.calibration.authorize('CPU_FAN1');
    expect(authResult.ok).toBe(false);
    expect(authResult.error).toMatch(/matériel non identifié/);
    expect(env.repos.calibration.get('CPU_FAN1').state).not.toBe('AUTHORIZED');
  }, 30_000);
});

describe('autorisation', () => {
  async function fullCalibration(fanId: FanId): Promise<void> {
    const key = env.hwmon.outputKeyByLabel(fanId)!;
    host.calibration.start(fanId, key);
    host.calibration.identify(fanId);
    await waitIdle(fanId, 30_000);
    host.calibration.confirmIdentification(fanId, { assignedHardware: HARDWARE_FOR[fanId] });
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

  // Scénario complet exigé après le correctif du bouton de confirmation
  // (voir describe('garde-fou identification') plus bas) : identify →
  // confirmIdentification → testRpm → detectMinimum → testSoftwareControl →
  // testBiosReturn → authorize, sur au moins deux sorties distinctes.
  it.each<FanId>(['CPU_FAN1', 'SYS_FAN4'])(
    'autorise après le parcours complet et prend le contrôle (%s)',
    async (fanId) => {
      await fullCalibration(fanId);
      const result = host.calibration.authorize(fanId);
      expect(result.ok).toBe(true);

      const record = env.repos.calibration.get(fanId);
      expect(record.state).toBe('AUTHORIZED');
      expect(record.assignedHardware).toBe(HARDWARE_FOR[fanId]);
      expect(record.calibratedAt).not.toBeNull();
      expect(record.kernelVersion).toBeTruthy();

      // Le moteur reprend la sortie sous contrôle logiciel.
      await waitFor(
        () => host.state().outputs.find((o) => o.id === fanId)!.controlState === 'SOFTWARE_CONTROLLED',
        6000,
        'prise de contrôle après autorisation',
      );
    },
    180_000,
  );

  // Preuve requise avant d'appliquer la révocation SQL proposée pour SYS_FAN2 :
  // state='RESTRICTED' + software_control_validated=0 + bios_return=NULL +
  // calibrated_at=NULL (sans toucher outputKey/assignedHardware/rpmValidation/
  // minimumPwm) doit exiger exactement test-software-control et test-bios-return
  // avant une nouvelle autorisation — ni identification, ni test RPM, ni minimum.
  it('après révocation (RESTRICTED), seules test-software-control et test-bios-return suffisent avant une nouvelle autorisation', async () => {
    await fullCalibration('SYS_FAN2');
    expect(host.calibration.authorize('SYS_FAN2').ok).toBe(true);

    const authorizedRecord = env.repos.calibration.get('SYS_FAN2');
    expect(authorizedRecord.state).toBe('AUTHORIZED');
    // Révocation telle que proposée : mêmes champs que le script SQL, rien d'autre.
    env.repos.calibration.save({
      ...authorizedRecord,
      state: 'RESTRICTED',
      softwareControlValidated: false,
      biosReturn: null,
      calibratedAt: null,
    });

    // Sans rien refaire d'autre : refus attendu, motifs précis.
    const premature = host.calibration.authorize('SYS_FAN2');
    expect(premature.ok).toBe(false);
    expect(premature.error).toMatch(/contrôle logiciel non validé/);
    expect(premature.error).toMatch(/retour BIOS non confirmé/);
    // Preuve que rien d'autre n'est requis : ni identification, ni RPM, ni minimum.
    expect(premature.error).not.toMatch(/matériel non identifié|retour RPM incohérent|minimum non déterminé/);

    // authorize() a supprimé la session en mémoire (finish()) : il faut la
    // rouvrir avec le même outputKey déjà connu — un préalable technique
    // transparent, pas une étape de l'assistant, avant de pouvoir relancer
    // test-software-control et test-bios-return.
    expect(host.calibration.start('SYS_FAN2', authorizedRecord.outputKey!).ok).toBe(true);
    // L'état RESTRICTED et l'affectation matérielle survivent à la réouverture.
    expect(env.repos.calibration.get('SYS_FAN2').state).toBe('RESTRICTED');
    expect(env.repos.calibration.get('SYS_FAN2').assignedHardware).toBe(HARDWARE_FOR.SYS_FAN2);

    // Uniquement les deux étapes citées — pas identify, pas testRpm, pas detectMinimum.
    expect(host.calibration.testSoftwareControl('SYS_FAN2').ok).toBe(true);
    await waitIdle('SYS_FAN2', 30_000);
    expect(host.calibration.testBiosReturn('SYS_FAN2').ok).toBe(true);
    await waitIdle('SYS_FAN2', 30_000);

    const result = host.calibration.authorize('SYS_FAN2');
    expect(result.ok).toBe(true);
    expect(env.repos.calibration.get('SYS_FAN2').state).toBe('AUTHORIZED');
    // L'identification et la mesure RPM d'origine n'ont pas été refaites.
    expect(env.repos.calibration.get('SYS_FAN2').assignedHardware).toBe(HARDWARE_FOR.SYS_FAN2);
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

// =====================================================================
// Arrêt du service pendant une calibration
// =====================================================================
//
// Régression observée sur Ubuntu Server : une étape de calibration différée
// reprenait la main après `db.close()` et produisait un rejet non géré
// (« TypeError: The database connection is not open » depuis
// CalibrationController.restoreInitial). `FanHost.stop()` doit désormais
// interrompre et attendre les étapes en vol, puis restaurer l'état PWM
// initial, avant l'arrêt du moteur et avant que l'appelant ferme SQLite.

describe('arrêt pendant une calibration', () => {
  it('interrompt l’étape en cours et referme la session', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    expect(host.calibration.start('CPU_FAN1', key).ok).toBe(true);
    expect(host.calibration.identify('CPU_FAN1').ok).toBe(true);
    await sleep(250);
    expect(host.calibration.session('CPU_FAN1')?.busy).toBe(true);

    await host.stop();

    expect(host.calibration.sessionsList()).toHaveLength(0);
    expect(host.calibration.session('CPU_FAN1')).toBeNull();
  }, 60_000);

  it('restaure l’état PWM initial avant la fermeture de la base', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    await identifyAndConfirm('CPU_FAN1');
    const initialMode = host.calibration.session('CPU_FAN1')!.initial.enableMode;
    const initialPwm = host.calibration.session('CPU_FAN1')!.initial.pwmPercent;
    expect(initialMode).toBe(SIM_MODE_BIOS);

    host.calibration.detectMinimum('CPU_FAN1');
    await waitFor(() => env.hwmon.readEnableMode(key) === SIM_MODE_MANUAL, 6000, 'passage en mode manuel');

    await host.stop();
    env.closeDb();

    expect(env.hwmon.readEnableMode(key)).toBe(initialMode);
    expect(env.hwmon.readPwmPercent(key)).toBe(initialPwm);
  }, 60_000);

  it('ne produit aucun rejet de promesse non géré si SQLite est fermée juste après', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
      host.calibration.start('CPU_FAN1', key);
      // Étape longue, qui écrit en base à plusieurs reprises.
      host.calibration.identify('CPU_FAN1');
      await sleep(300);

      // Séquence exacte de `pcia-fand` : arrêt de l'hôte, puis fermeture de la base.
      await host.stop();
      env.closeDb();

      // Laisse le temps à un éventuel callback résiduel de se manifester.
      await sleep(800);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 60_000);

  it('refuse toute nouvelle étape une fois l’arrêt engagé', async () => {
    const key = env.hwmon.outputKeyByLabel('CPU_FAN1')!;
    host.calibration.start('CPU_FAN1', key);
    await host.stop();

    // Plus aucune session : l'étape est refusée, sans écriture matérielle ni base.
    expect(host.calibration.identify('CPU_FAN1').ok).toBe(false);
    expect(host.calibration.testRpm('CPU_FAN1').ok).toBe(false);
  }, 60_000);
});
