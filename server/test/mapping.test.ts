/** Mappage « sortie logique ↔ matériel hwmon ».
 *
 *  Ces tests construisent une **fausse arborescence sysfs** dans un répertoire
 *  temporaire, avec de vrais liens symboliques, pour exercer le backend sysfs
 *  réel sans jamais toucher au matériel de la machine. Aucun fichier de /sys
 *  n'est lu ni écrit ici.
 *
 *  Ce qui est couvert, point par point :
 *   - détection stable des contrôleurs ;
 *   - renumérotation des `hwmonN` après un redémarrage ;
 *   - canal RPM absent, valeur illisible, ventilateur réellement arrêté ;
 *   - configuration ancienne (sans mappage) et configuration à chemins explicites ;
 *   - correspondance entre sortie PWM et canal RPM.
 */

import {
  mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SysfsHwmonBackend } from '../src/hwmon/sysfs.js';
import { collectTachs, controllerMatches, deviceSignature, resolveFanMapping } from '../src/hwmon/mapping.js';
import { CONFIGURABLE_FAN_IDS, configSchema, loadConfig } from '../src/config.js';
import { FAN_IDS } from '../src/contract.js';

// ---------------------------------------------------------------------
// Fausse arborescence /sys
// ---------------------------------------------------------------------

interface FakeController {
  /** Contenu du fichier `name` (ex. nct6798). */
  name: string;
  /** Répertoire device sous /sys/devices (ex. platform/nct6775.2592). */
  device: string;
  driver: string;
  subsystem: string;
  /** Sorties PWM : index → valeur brute 0–255. */
  pwm: Record<number, number>;
  /** Entrées tachymétriques : index → contenu du fichier (chaîne brute). */
  fan: Record<number, string>;
  temp?: Record<number, string>;
}

class FakeSysfs {
  readonly base: string;
  /** Racine présentée au backend : l'équivalent de /sys/class/hwmon. */
  readonly classRoot: string;

  constructor() {
    this.base = mkdtempSync(join(tmpdir(), 'pcia-sysfs-'));
    this.classRoot = join(this.base, 'class', 'hwmon');
    mkdirSync(this.classRoot, { recursive: true });
  }

  /** Crée un contrôleur et l'expose sous `hwmon<index>`. */
  add(controller: FakeController, hwmonIndex: number): string {
    const deviceDir = join(this.base, 'devices', controller.device);
    const hwmonDir = join(deviceDir, 'hwmon', `hwmon${hwmonIndex}`);
    mkdirSync(hwmonDir, { recursive: true });

    writeFileSync(join(hwmonDir, 'name'), `${controller.name}\n`);
    // `device` pointe vers le device parent, comme dans le vrai sysfs.
    symlinkSync(deviceDir, join(hwmonDir, 'device'));

    const driverDir = join(this.base, 'bus', controller.subsystem, 'drivers', controller.driver);
    mkdirSync(driverDir, { recursive: true });
    symlinkSync(driverDir, join(deviceDir, 'driver'));

    const subsystemDir = join(this.base, 'bus', controller.subsystem);
    mkdirSync(subsystemDir, { recursive: true });
    symlinkSync(subsystemDir, join(deviceDir, 'subsystem'));

    writeFileSync(join(deviceDir, 'uevent'), `DRIVER=${controller.driver}\nMODALIAS=${controller.subsystem}:${controller.driver}\n`);

    for (const [index, value] of Object.entries(controller.pwm)) {
      writeFileSync(join(hwmonDir, `pwm${index}`), `${value}\n`);
      writeFileSync(join(hwmonDir, `pwm${index}_enable`), '5\n');
    }
    for (const [index, value] of Object.entries(controller.fan)) {
      writeFileSync(join(hwmonDir, `fan${index}_input`), `${value}\n`);
    }
    for (const [index, value] of Object.entries(controller.temp ?? {})) {
      writeFileSync(join(hwmonDir, `temp${index}_input`), `${value}\n`);
    }

    symlinkSync(hwmonDir, join(this.classRoot, `hwmon${hwmonIndex}`));
    return hwmonDir;
  }

  /** Renumérote un contrôleur : c'est ce que fait le noyau après un
   *  redémarrage quand les pilotes sont sondés dans un autre ordre. */
  renumber(from: number, to: number): void {
    const link = join(this.classRoot, `hwmon${from}`);
    const real = realpathSync(link);
    unlinkSync(link);
    // Le répertoire réel change aussi de nom dans /sys/devices/.../hwmon/.
    const renamed = real.replace(/hwmon\d+$/, `hwmon${to}`);
    renameSync(real, renamed);
    symlinkSync(renamed, join(this.classRoot, `hwmon${to}`));
  }

  writeRaw(hwmonIndex: number, file: string, content: string): void {
    const real = realpathSync(join(this.classRoot, `hwmon${hwmonIndex}`));
    writeFileSync(join(real, file), content);
  }

  removeFile(hwmonIndex: number, file: string): void {
    const real = realpathSync(join(this.classRoot, `hwmon${hwmonIndex}`));
    unlinkSync(join(real, file));
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}

/** Super-I/O type carte mère : 5 sorties, 5 tachymètres, décalés d'un cran.
 *
 *  Le décalage est volontaire : sur beaucoup de cartes, `pwm1` n'est *pas*
 *  associé à `fan1_input`. C'est exactement le piège que le mappage explicite
 *  doit permettre d'éviter. */
const SUPERIO: FakeController = {
  name: 'nct6798',
  device: 'platform/nct6775.2592',
  driver: 'nct6775',
  subsystem: 'platform',
  pwm: { 1: 128, 2: 100, 3: 90, 4: 200, 5: 200 },
  fan: { 1: '1240', 2: '780', 3: '810', 4: '2100', 5: '2050' },
  temp: { 1: '42000', 2: '38000' },
};

const CORETEMP: FakeController = {
  name: 'coretemp',
  device: 'platform/coretemp.0',
  driver: 'coretemp',
  subsystem: 'platform',
  pwm: {},
  fan: {},
  temp: { 1: '55000' },
};

describe('signature de chemin indépendante du numéro hwmon', () => {
  it('neutralise le segment hwmonN', () => {
    expect(deviceSignature('/sys/devices/platform/nct6775.2592/hwmon/hwmon3/pwm1'))
      .toBe(deviceSignature('/sys/devices/platform/nct6775.2592/hwmon/hwmon7/pwm1'));
  });

  it('distingue deux fichiers différents du même contrôleur', () => {
    expect(deviceSignature('/sys/devices/platform/nct6775.2592/hwmon/hwmon3/pwm1'))
      .not.toBe(deviceSignature('/sys/devices/platform/nct6775.2592/hwmon/hwmon3/pwm2'));
  });

  it('distingue deux contrôleurs différents', () => {
    expect(deviceSignature('/sys/devices/platform/nct6775.2592/hwmon/hwmon3/pwm1'))
      .not.toBe(deviceSignature('/sys/devices/platform/it87.552/hwmon/hwmon3/pwm1'));
  });
});

describe('critères d’identification d’un contrôleur', () => {
  const identity = {
    key: 'nct6798:abc123', driverName: 'nct6798', kernelDriver: 'nct6775',
    bus: 'platform', address: 'nct6775.2592', modalias: null, currentPath: '/sys/class/hwmon/hwmon3',
  };

  it('accepte un critère unique, insensible à la casse', () => {
    expect(controllerMatches(identity, { name: 'NCT6798' })).toBe(true);
    expect(controllerMatches(identity, { address: 'nct6775.2592' })).toBe(true);
  });

  it('exige que tous les critères fournis correspondent', () => {
    expect(controllerMatches(identity, { name: 'nct6798', address: 'it87.552' })).toBe(false);
    expect(controllerMatches(identity, { name: 'it8686' })).toBe(false);
  });
});

describe('mappage sur une arborescence sysfs factice', () => {
  let sysfs: FakeSysfs;
  let backend: SysfsHwmonBackend;

  const discover = () => {
    // Lecture seule stricte : aucun test ne doit pouvoir écrire un pwm.
    backend = new SysfsHwmonBackend({ root: sysfs.classRoot, allowWrites: false });
    return backend.discover();
  };
  const tachs = () => collectTachs(backend.cached(), (k) => backend.tachKeysForController(k));

  beforeEach(() => {
    sysfs = new FakeSysfs();
    sysfs.add(CORETEMP, 0);
    sysfs.add(SUPERIO, 1);
  });

  afterEach(() => sysfs.cleanup());

  it('découvre les cinq sorties du Super-I/O', () => {
    const discovery = discover();
    expect(discovery.pwmOutputs).toHaveLength(5);
    expect(discovery.controllers.map((c) => c.driverName).sort()).toEqual(['coretemp', 'nct6798']);
  });

  it('résout le mappage par nom de contrôleur et index', () => {
    discover();
    const resolved = resolveFanMapping(
      { CPU_FAN1: { controller: { name: 'nct6798' }, pwm: 1, tach: 1 } },
      backend.cached(), tachs(),
    );
    const cpu = resolved.get('CPU_FAN1')!;
    expect(cpu.unresolved).toBe(false);
    expect(cpu.warnings).toEqual([]);
    expect(backend.getOutput(cpu.outputKey!)!.index).toBe(1);
  });

  it('résout le mappage par chemin explicite', () => {
    discover();
    const pwmPath = join(sysfs.classRoot, 'hwmon1', 'pwm4');
    const resolved = resolveFanMapping(
      { SYS_FAN3: { pwmPath, tachPath: join(sysfs.classRoot, 'hwmon1', 'fan4_input') } },
      backend.cached(), tachs(),
      { realpath: (p) => realpathSync(p) },
    );
    const fan3 = resolved.get('SYS_FAN3')!;
    expect(fan3.unresolved).toBe(false);
    expect(backend.getOutput(fan3.outputKey!)!.index).toBe(4);
    expect(fan3.tachKey).toContain('#fan4');
  });

  it('retrouve les mêmes sorties après renumérotation des hwmon', () => {
    discover();
    const before = resolveFanMapping(
      {
        CPU_FAN1: { controller: { name: 'nct6798' }, pwm: 1, tach: 1 },
        SYS_FAN4: { pwmPath: join(sysfs.classRoot, 'hwmon1', 'pwm5'), tach: 5 },
      },
      backend.cached(), tachs(),
      { realpath: (p) => realpathSync(p) },
    );

    // Redémarrage : le noyau sonde les pilotes dans un autre ordre.
    sysfs.renumber(1, 6);
    discover();
    const after = resolveFanMapping(
      {
        CPU_FAN1: { controller: { name: 'nct6798' }, pwm: 1, tach: 1 },
        // Le chemin écrit dans config.yaml contient toujours l'ancien numéro.
        SYS_FAN4: { pwmPath: join(sysfs.classRoot, 'hwmon1', 'pwm5'), tach: 5 },
      },
      backend.cached(), tachs(),
      { realpath: (p) => realpathSync(p) },
    );

    // L'identification par contrôleur survit sans réserve.
    expect(after.get('CPU_FAN1')!.outputKey).toBe(before.get('CPU_FAN1')!.outputKey);
    expect(after.get('CPU_FAN1')!.unresolved).toBe(false);
    // Le chemin explicite, lui, ne peut plus être résolu : le lien
    // /sys/class/hwmon/hwmon1 n'existe plus. L'échec est annoncé, jamais
    // silencieux — et surtout il ne désigne pas une autre sortie par erreur.
    expect(after.get('SYS_FAN4')!.unresolved).toBe(true);
    expect(after.get('SYS_FAN4')!.warnings.join(' ')).toMatch(/aucun contrôleur/);
  });

  it('résiste à la renumérotation même avec un chemin explicite sous /sys/devices', () => {
    discover();
    const real = realpathSync(join(sysfs.classRoot, 'hwmon1'));
    const configured = join(real, 'pwm3');

    sysfs.renumber(1, 9);
    discover();
    const resolved = resolveFanMapping(
      { SYS_FAN2: { pwmPath: configured } },
      backend.cached(), tachs(),
      { realpath: (p) => realpathSync(p) },
    );
    // Le device (`nct6775.2592`) n'a pas bougé : la sortie est retrouvée.
    expect(resolved.get('SYS_FAN2')!.unresolved).toBe(false);
    expect(backend.getOutput(resolved.get('SYS_FAN2')!.outputKey!)!.index).toBe(3);
  });

  it('associe une sortie PWM à un canal RPM décalé', () => {
    discover();
    // Sur cette carte factice, pwm2 est refroidi par le ventilateur dont le
    // tachymètre est fan3_input : c'est tout l'objet du mappage explicite.
    const resolved = resolveFanMapping(
      { SYS_FAN1: { controller: { name: 'nct6798' }, pwm: 2, tach: 3 } },
      backend.cached(), tachs(),
    );
    const key = resolved.get('SYS_FAN1')!;
    backend.bindTach(key.outputKey!, key.tachKey!);
    expect(backend.readRpm(key.outputKey!)).toBe(810);   // fan3_input, pas fan2_input
  });

  it('signale un canal RPM inexistant sans inventer de valeur', () => {
    discover();
    const resolved = resolveFanMapping(
      { SYS_FAN1: { controller: { name: 'nct6798' }, pwm: 2, tach: 9 } },
      backend.cached(), tachs(),
    );
    const entry = resolved.get('SYS_FAN1')!;
    expect(entry.outputKey).not.toBeNull();
    expect(entry.tachKey).toBeNull();
    expect(entry.warnings.join(' ')).toMatch(/fan9_input/);
    backend.bindTach(entry.outputKey!, entry.tachKey!);
    // Aucun canal : `null` (« inconnu »), surtout pas 0 (« arrêté »).
    expect(backend.readRpm(entry.outputKey!)).toBeNull();
  });

  it('accepte une déclaration explicite « pas de tachymètre »', () => {
    discover();
    const resolved = resolveFanMapping(
      { SYS_FAN2: { controller: { name: 'nct6798' }, pwm: 3, tach: null } },
      backend.cached(), tachs(),
    );
    const entry = resolved.get('SYS_FAN2')!;
    expect(entry.tachKey).toBeNull();
    expect(entry.warnings).toEqual([]);
  });

  it('refuse d’attribuer deux sorties logiques au même PWM', () => {
    discover();
    const resolved = resolveFanMapping(
      {
        SYS_FAN3: { controller: { name: 'nct6798' }, pwm: 4 },
        SYS_FAN4: { controller: { name: 'nct6798' }, pwm: 4 },
      },
      backend.cached(), tachs(),
    );
    expect(resolved.get('SYS_FAN3')!.outputKey).not.toBeNull();
    expect(resolved.get('SYS_FAN4')!.outputKey).toBeNull();
    expect(resolved.get('SYS_FAN4')!.warnings.join(' ')).toMatch(/déjà attribuée/);
  });

  it('signale une désignation ambiguë au lieu de choisir au hasard', () => {
    discover();
    const resolved = resolveFanMapping(
      { CPU_FAN1: { controller: { name: 'nct6798' } } },   // 5 sorties correspondent
      backend.cached(), tachs(),
    );
    expect(resolved.get('CPU_FAN1')!.outputKey).toBeNull();
    expect(resolved.get('CPU_FAN1')!.warnings.join(' ')).toMatch(/5 sorties/);
  });

  it('signale un contrôleur absent sans se rabattre sur un autre', () => {
    discover();
    const resolved = resolveFanMapping(
      { CPU_FAN1: { controller: { name: 'it8686' }, pwm: 1 } },
      backend.cached(), tachs(),
    );
    expect(resolved.get('CPU_FAN1')!.outputKey).toBeNull();
    expect(resolved.get('CPU_FAN1')!.unresolved).toBe(true);
  });
});

describe('lecture RPM dégradée', () => {
  let sysfs: FakeSysfs;
  let backend: SysfsHwmonBackend;

  beforeEach(() => {
    sysfs = new FakeSysfs();
    sysfs.add(SUPERIO, 1);
    backend = new SysfsHwmonBackend({ root: sysfs.classRoot, allowWrites: false });
    backend.discover();
  });
  afterEach(() => sysfs.cleanup());

  const cpuKey = () => {
    const tach = collectTachs(backend.cached(), (k) => backend.tachKeysForController(k))
      .find((t) => t.index === 1)!;
    const output = backend.cached().pwmOutputs.find((o) => o.index === 1)!;
    backend.bindTach(output.key, tach.key);
    return output.key;
  };

  it('lit une vitesse réelle', () => {
    expect(backend.readRpm(cpuKey())).toBe(1240);
  });

  it('renvoie null sur une valeur non numérique, pas 0', () => {
    const key = cpuKey();
    sysfs.writeRaw(1, 'fan1_input', 'n/a\n');
    expect(backend.readRpm(key)).toBeNull();
  });

  it('renvoie null quand le fichier disparaît, pas 0', () => {
    const key = cpuKey();
    sysfs.removeFile(1, 'fan1_input');
    expect(backend.readRpm(key)).toBeNull();
  });

  it('distingue un ventilateur réellement arrêté d’une mesure absente', () => {
    const key = cpuKey();
    sysfs.writeRaw(1, 'fan1_input', '0\n');
    // 0 est une mesure valide : le ventilateur est à l'arrêt.
    expect(backend.readRpm(key)).toBe(0);
  });
});

describe('compatibilité des configurations', () => {
  it('accepte une configuration ancienne, sans section fans', () => {
    const parsed = configSchema.parse({ server: { port: 4321 }, fanControl: { loopIntervalMs: 1000 } });
    expect(parsed.fans.mapping).toEqual({});
  });

  it('ne mappe rien quand la configuration est vide — comportement historique', () => {
    const parsed = configSchema.parse({});
    const resolved = resolveFanMapping(parsed.fans.mapping, {
      controllers: [], pwmOutputs: [], tempSensors: [], orphanTachs: [], warnings: [],
    }, []);
    expect(resolved.size).toBe(0);
  });

  it('refuse une entrée sans aucun critère d’identification', () => {
    const result = configSchema.safeParse({ fans: { mapping: { CPU_FAN1: { pwm: 1 } } } });
    expect(result.success).toBe(false);
  });

  it('garde la même liste de sorties que le contrat applicatif', () => {
    // `config.ts` duplique volontairement FAN_IDS pour ne dépendre d'aucun
    // module applicatif : ce test empêche les deux listes de diverger.
    expect([...CONFIGURABLE_FAN_IDS]).toEqual([...FAN_IDS]);
  });

  it('préserve les identifiants matériels des seuils de température', () => {
    // `case-front` ne doit pas devenir `caseFront`, ni `v100-1` devenir `v1001` :
    // sinon les seuils saisis sont rangés sous une clé qui ne correspond à aucun
    // matériel, et ne s'appliquent jamais.
    const file = join(mkdtempSync(join(tmpdir(), 'pcia-cfg-')), 'config.yaml');
    writeFileSync(file, [
      'alerts:',
      '  temperature_thresholds:',
      '    case-front: [45, 55]',
      '    v100-1: [80, 88]',
      'fan_control:',
      '  sensor_failure_pwm: 75',
    ].join('\n'));
    const { config, warnings } = loadConfig(file);
    expect(warnings).toEqual([]);
    expect(config.alerts.temperatureThresholds['case-front']).toEqual([45, 55]);
    expect(config.alerts.temperatureThresholds['v100-1']).toEqual([80, 88]);
    // Les clés d'options, elles, restent normalisées.
    expect(config.fanControl.sensorFailurePwm).toBe(75);
  });

  it('refuse une sortie logique inconnue', () => {
    const result = configSchema.safeParse({
      fans: { mapping: { SYS_FAN9: { controller: { name: 'nct6798' }, pwm: 1 } } },
    });
    expect(result.success).toBe(false);
  });
});
