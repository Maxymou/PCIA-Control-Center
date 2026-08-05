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
import {
  collectTachs, controllerMatchOf, controllerMatches, deviceSignature, resolveFanMapping,
} from '../src/hwmon/mapping.js';
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

/** Réplique du Super-I/O de la machine PCIA : NCT6795 sur MSI X299 SLI PLUS.
 *
 *  Six sorties, six tachymètres, et un décalage bien réel : `pwm1` est le
 *  connecteur de pompe (non branché), si bien qu'aucune sortie ne porte le même
 *  numéro que « son » rang logique. Les vitesses sont celles relevées sur la
 *  machine. */
const SUPERIO: FakeController = {
  name: 'nct6795',
  device: 'platform/nct6775.2592',
  driver: 'nct6775',
  subsystem: 'platform',
  //          PUMP  CPU   SYS1  SYS3  SYS4  SYS2
  pwm: { 1: 0, 2: 140, 3: 90, 4: 230, 5: 230, 6: 88 },
  fan: { 1: '0', 2: '2350', 3: '820', 4: '9500', 5: '9300', 6: '790' },
  temp: { 1: '42000', 2: '38000' },
};

/** Mappage confirmé dans le BIOS MSI, tel qu'il est livré dans config.example.yaml. */
const PCIA_MAPPING = {
  CPU_FAN1: { controllerName: 'nct6795', kernelDriver: 'nct6775', controllerAddress: 'nct6775.2592', pwm: 2, tach: 2 },
  SYS_FAN1: { controllerName: 'nct6795', kernelDriver: 'nct6775', controllerAddress: 'nct6775.2592', pwm: 3, tach: 3 },
  SYS_FAN2: { controllerName: 'nct6795', kernelDriver: 'nct6775', controllerAddress: 'nct6775.2592', pwm: 6, tach: 6 },
  SYS_FAN3: { controllerName: 'nct6795', kernelDriver: 'nct6775', controllerAddress: 'nct6775.2592', pwm: 4, tach: 4 },
  SYS_FAN4: { controllerName: 'nct6795', kernelDriver: 'nct6775', controllerAddress: 'nct6775.2592', pwm: 5, tach: 5 },
} as const;

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
    key: 'nct6798:abc123', driverName: 'nct6795', kernelDriver: 'nct6775',
    bus: 'platform', address: 'nct6775.2592', modalias: null, currentPath: '/sys/class/hwmon/hwmon3',
  };

  it('accepte un critère unique, insensible à la casse', () => {
    expect(controllerMatches(identity, { name: 'NCT6795' })).toBe(true);
    expect(controllerMatches(identity, { address: 'nct6775.2592' })).toBe(true);
  });

  it('exige que tous les critères fournis correspondent', () => {
    expect(controllerMatches(identity, { name: 'nct6795', address: 'it87.552' })).toBe(false);
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

  it('découvre les six sorties du Super-I/O', () => {
    const discovery = discover();
    expect(discovery.pwmOutputs).toHaveLength(6);
    expect(discovery.controllers.map((c) => c.driverName).sort()).toEqual(['coretemp', 'nct6795']);
  });

  it('résout le mappage par nom de contrôleur et index', () => {
    discover();
    const resolved = resolveFanMapping(
      { CPU_FAN1: { controller: { name: 'nct6795' }, pwm: 1, tach: 1 } },
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
        CPU_FAN1: { controller: { name: 'nct6795' }, pwm: 1, tach: 1 },
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
        CPU_FAN1: { controller: { name: 'nct6795' }, pwm: 1, tach: 1 },
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
      { SYS_FAN2: { controller: { name: 'nct6795' }, pwm: 6, tach: 6 } },
      backend.cached(), tachs(),
    );
    const key = resolved.get('SYS_FAN2')!;
    backend.bindTach(key.outputKey!, key.tachKey!);
    expect(backend.readRpm(key.outputKey!)).toBe(790);   // fan6_input, pas fan2_input
  });

  it('signale un canal RPM inexistant sans inventer de valeur', () => {
    discover();
    const resolved = resolveFanMapping(
      { SYS_FAN1: { controller: { name: 'nct6795' }, pwm: 2, tach: 9 } },
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
      { SYS_FAN2: { controller: { name: 'nct6795' }, pwm: 3, tach: null } },
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
        SYS_FAN3: { controller: { name: 'nct6795' }, pwm: 4 },
        SYS_FAN4: { controller: { name: 'nct6795' }, pwm: 4 },
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
      { CPU_FAN1: { controller: { name: 'nct6795' } } },   // 5 sorties correspondent
      backend.cached(), tachs(),
    );
    expect(resolved.get('CPU_FAN1')!.outputKey).toBeNull();
    expect(resolved.get('CPU_FAN1')!.warnings.join(' ')).toMatch(/6 sorties/);
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

describe('mappage confirmé de la machine PCIA', () => {
  let sysfs: FakeSysfs;
  let backend: SysfsHwmonBackend;

  const discover = () => {
    backend = new SysfsHwmonBackend({ root: sysfs.classRoot, allowWrites: false });
    backend.discover();
  };
  const tachs = () => collectTachs(backend.cached(), (k) => backend.tachKeysForController(k));

  beforeEach(() => {
    sysfs = new FakeSysfs();
    sysfs.add(CORETEMP, 0);
    sysfs.add(SUPERIO, 2);   // hwmon2, comme sur la machine
    discover();
  });
  afterEach(() => sysfs.cleanup());

  /** Vitesses attendues, connecteur par connecteur. */
  const EXPECTED: Record<string, { pwm: number; rpm: number }> = {
    CPU_FAN1: { pwm: 2, rpm: 2350 },
    SYS_FAN1: { pwm: 3, rpm: 820 },
    SYS_FAN2: { pwm: 6, rpm: 790 },
    SYS_FAN3: { pwm: 4, rpm: 9500 },
    SYS_FAN4: { pwm: 5, rpm: 9300 },
  };

  it('résout les cinq sorties sur le bon pwm et le bon canal RPM', () => {
    const resolved = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    for (const [fanId, expected] of Object.entries(EXPECTED)) {
      const entry = resolved.get(fanId as keyof typeof PCIA_MAPPING)!;
      expect(entry.unresolved, fanId).toBe(false);
      expect(entry.warnings, fanId).toEqual([]);
      expect(backend.getOutput(entry.outputKey!)!.index, fanId).toBe(expected.pwm);
      backend.bindTach(entry.outputKey!, entry.tachKey!);
      expect(backend.readRpm(entry.outputKey!), fanId).toBe(expected.rpm);
    }
  });

  it('n’attribue pas SYS_FAN2 au canal fan2 — le piège du numéro', () => {
    const resolved = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    const sysFan2 = resolved.get('SYS_FAN2')!;
    expect(sysFan2.tachKey).toContain('#fan6');
    // fan2_input, c'est le CPU : s'en servir pour SYS_FAN2 masquerait un arrêt
    // du ventilateur avant tant que le ventilateur du CPU tourne.
    expect(sysFan2.tachKey).not.toContain('#fan2');
  });

  it('laisse pwm1 (PUMP_FAN1) hors des sorties pilotées', () => {
    const resolved = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    const usedIndexes = [...resolved.values()]
      .map((m) => backend.getOutput(m.outputKey!)!.index)
      .sort((a, b) => a - b);
    expect(usedIndexes).toEqual([2, 3, 4, 5, 6]);
  });

  it('accepte les clés plates controller_name / kernel_driver / controller_address', () => {
    const parsed = configSchema.parse({ fans: { mapping: PCIA_MAPPING } });
    const resolved = resolveFanMapping(parsed.fans.mapping, backend.cached(), tachs());
    expect(resolved.get('CPU_FAN1')!.unresolved).toBe(false);
    // Les alias plats produisent les mêmes critères que la forme imbriquée.
    expect(controllerMatchOf(parsed.fans.mapping.CPU_FAN1!)).toMatchObject({
      name: 'nct6795', driver: 'nct6775', address: 'nct6775.2592',
    });
    expect(controllerMatchOf({ controller: { name: 'nct6795' } })).toMatchObject({ name: 'nct6795' });
  });

  it('survit à une renumérotation hwmon2 → hwmon5', () => {
    const before = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    const keysBefore = [...before.values()].map((m) => m.outputKey);

    sysfs.renumber(2, 5);
    discover();

    const after = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    expect([...after.values()].map((m) => m.outputKey)).toEqual(keysBefore);
    expect([...after.values()].every((m) => !m.unresolved)).toBe(true);
  });

  it('refuse le mappage si le contrôleur est remplacé par un autre modèle', () => {
    const other = { ...SUPERIO, name: 'nct6798', device: 'platform/nct6775.664' };
    sysfs.cleanup();
    sysfs = new FakeSysfs();
    sysfs.add(other, 2);
    discover();
    const resolved = resolveFanMapping(PCIA_MAPPING, backend.cached(), tachs());
    expect([...resolved.values()].every((m) => m.unresolved)).toBe(true);
  });

  it('déclare PUMP_FAN1 comme connecteur non raccordé', () => {
    const parsed = configSchema.parse({
      fans: {
        mapping: PCIA_MAPPING,
        unconnected: {
          PUMP_FAN1: {
            controllerName: 'nct6795', kernelDriver: 'nct6775',
            controllerAddress: 'nct6775.2592', pwm: 1, tach: 1,
          },
        },
      },
    });
    const resolved = resolveFanMapping<string>(parsed.fans.unconnected, backend.cached(), tachs());
    const pump = resolved.get('PUMP_FAN1')!;
    expect(pump.unresolved).toBe(false);
    expect(backend.getOutput(pump.outputKey!)!.index).toBe(1);
    backend.bindTach(pump.outputKey!, pump.tachKey!);
    // 0 RPM mesuré : rien n'est branché, et c'est une information exacte.
    expect(backend.readRpm(pump.outputKey!)).toBe(0);
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

  /** CPU_FAN1 = pwm2 / fan2_input sur cette carte. */
  const cpuKey = () => {
    const tach = collectTachs(backend.cached(), (k) => backend.tachKeysForController(k))
      .find((t) => t.index === 2)!;
    const output = backend.cached().pwmOutputs.find((o) => o.index === 2)!;
    backend.bindTach(output.key, tach.key);
    return output.key;
  };

  it('lit une vitesse réelle', () => {
    expect(backend.readRpm(cpuKey())).toBe(2350);
  });

  it('renvoie null sur une valeur non numérique, pas 0', () => {
    const key = cpuKey();
    sysfs.writeRaw(1, 'fan2_input', 'n/a\n');
    expect(backend.readRpm(key)).toBeNull();
  });

  it('renvoie null quand le fichier disparaît, pas 0', () => {
    const key = cpuKey();
    sysfs.removeFile(1, 'fan2_input');
    expect(backend.readRpm(key)).toBeNull();
  });

  it('distingue un ventilateur réellement arrêté d’une mesure absente', () => {
    const key = cpuKey();
    sysfs.writeRaw(1, 'fan2_input', '0\n');
    // 0 est une mesure valide : le ventilateur est à l'arrêt.
    expect(backend.readRpm(key)).toBe(0);
  });

  it('lit 0 RPM sur le connecteur de pompe non branché — c’est une mesure', () => {
    // PUMP_FAN1 = pwm1 / fan1_input, rien de raccordé. Le 0 vient du matériel,
    // il ne doit surtout pas être confondu avec une mesure indisponible.
    const tach = collectTachs(backend.cached(), (k) => backend.tachKeysForController(k))
      .find((t) => t.index === 1)!;
    const output = backend.cached().pwmOutputs.find((o) => o.index === 1)!;
    backend.bindTach(output.key, tach.key);
    expect(backend.readRpm(output.key)).toBe(0);
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
      fans: { mapping: { SYS_FAN9: { controller: { name: 'nct6795' }, pwm: 1 } } },
    });
    expect(result.success).toBe(false);
  });
});
