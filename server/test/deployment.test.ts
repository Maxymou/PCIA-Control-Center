/** Déploiement systemd : un seul moteur de ventilation, un runtime partagé.
 *
 *  Ces tests reproduisent la topologie réelle installée sur Ubuntu Server :
 *  `pcia-fan-control.service` détient le moteur et le verrou, tandis que
 *  `pcia-control-center.service` (le serveur web) ne fait que le piloter par
 *  IPC. Ils vérifient qu'aucun scénario d'arrêt ou de redémarrage ne produit
 *  un second écrivain PWM, ni ne détruit le runtime de l'autre service.
 *
 *  Aucun matériel réel n'est touché : backend hwmon simulé, base temporaire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, fanSocketPath, fanStatePath, loadConfig } from '../src/config.js';
import { FanGateway } from '../src/app/fanGateway.js';
import { startEmbeddedFanHost } from '../src/fan/embedded.js';
import { FanHost } from '../src/fan/host.js';
import { acquireFanLock, lockPath } from '../src/fan/lock.js';
import { SIM_MODE_BIOS } from '../src/hwmon/simulated.js';
import { createTestEnv, sleep, waitFor, type TestEnv } from './helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGED_CONFIG = join(REPO_ROOT, 'packaging', 'config.example.yaml');

let env: TestEnv;
/** Hôtes ouverts pendant un test, arrêtés systématiquement à la fin. */
let opened: FanHost[] = [];

/** Construit un moteur comme le fait `pcia-fand` : IPC + fichier d'état. */
function buildDaemon(overrides: Record<string, unknown> = {}): FanHost {
  const config = structuredClone(env.config);
  config.fanControl.loopIntervalMs = 200;
  config.fanControl.heartbeatIntervalMs = 200;
  Object.assign(config.fanControl, overrides);
  const host = new FanHost({
    config, repos: env.repos, hwmon: env.hwmon, mode: 'demo',
    gpuProvider: () => env.world.gpus(),
  });
  opened.push(host);
  return host;
}

/** Construit le moteur candidat du serveur web (sans IPC : il ne sert pas). */
function buildWebCandidate(config = env.config): FanHost {
  const host = new FanHost({
    config, repos: env.repos, hwmon: env.hwmon, mode: 'demo',
    gpuProvider: () => env.world.gpus(), withIpc: false, withStateFile: false,
  });
  opened.push(host);
  return host;
}

function withEmbedded(mode: 'auto' | 'always' | 'never') {
  const config = structuredClone(env.config);
  config.fanControl.embedded = mode;
  return config;
}

beforeEach(() => {
  env = createTestEnv();
  opened = [];
});

afterEach(async () => {
  for (const host of opened) {
    try {
      await host.stop();
    } catch {
      /* déjà arrêté */
    }
  }
  opened = [];
  env.cleanup();
});

// =====================================================================
// Exclusivité du moteur
// =====================================================================

describe('exclusivité du moteur de ventilation', () => {
  it('refuse un moteur embarqué quand le daemon détient déjà le verrou', () => {
    const daemon = buildDaemon();
    expect(daemon.start().started).toBe(true);

    const web = buildWebCandidate();
    const second = web.start();
    expect(second.started).toBe(false);
    expect(second.heldBy).toBe(process.pid);
  });

  it('ne construit aucun moteur embarqué en production (embedded: never)', () => {
    const daemon = buildDaemon();
    expect(daemon.start().started).toBe(true);

    let built = 0;
    const result = startEmbeddedFanHost(withEmbedded('never'), () => {
      built += 1;
      return buildWebCandidate();
    });

    expect(result.outcome).toBe('disabled');
    expect(result.host).toBeNull();
    // Aucun FanHost instancié : pas même une tentative sur le verrou.
    expect(built).toBe(0);
    // Le verrou du daemon est intact.
    expect(readFileSync(lockPath(env.config.storage.runtimeDir), 'utf8').trim()).toBe(String(process.pid));
  });

  it('bascule sur le moteur externe en mode auto quand le verrou est pris', () => {
    const daemon = buildDaemon();
    daemon.start();

    const result = startEmbeddedFanHost(withEmbedded('auto'), () => buildWebCandidate(withEmbedded('auto')));
    expect(result.outcome).toBe('external');
    expect(result.host).toBeNull();
    expect(result.heldBy).toBe(process.pid);
  });

  it('reste en supervision seule si `always` est demandé mais le verrou pris', () => {
    const daemon = buildDaemon();
    daemon.start();

    const result = startEmbeddedFanHost(withEmbedded('always'), () => buildWebCandidate(withEmbedded('always')));
    expect(result.outcome).toBe('blocked');
    expect(result.host).toBeNull();
  });

  it('démarre le moteur embarqué en mono-processus quand le verrou est libre', () => {
    const result = startEmbeddedFanHost(withEmbedded('auto'), () => buildWebCandidate(withEmbedded('auto')));
    expect(result.outcome).toBe('started');
    expect(result.host).not.toBeNull();
    expect(result.heldBy).toBe(process.pid);
  });
});

// =====================================================================
// Runtime partagé /run/pcia-control-center
// =====================================================================

describe('runtime partagé', () => {
  it('laisse le daemon actif quand le serveur web s’arrête', async () => {
    const daemon = buildDaemon();
    expect(daemon.start().started).toBe(true);
    await waitFor(() => existsSync(fanSocketPath(env.config)), 5000, 'socket du daemon');

    // Le serveur web ne détient aucun moteur : il pilote le daemon par IPC.
    const gateway = new FanGateway(withEmbedded('never'), null);
    expect(gateway.isEmbedded()).toBe(false);
    expect(gateway.available()).toBe(true);
    await expect(gateway.send('ping')).resolves.toMatchObject({ pong: true });

    // Arrêt du serveur web : rien de ce qui appartient au daemon ne bouge.
    // (aucun FanHost à arrêter, aucun fichier runtime à supprimer)
    expect(existsSync(fanSocketPath(env.config))).toBe(true);
    expect(existsSync(lockPath(env.config.storage.runtimeDir))).toBe(true);

    await waitFor(() => existsSync(fanStatePath(env.config)), 5000, 'fichier d’état');
    const before = daemon.state().heartbeat;
    await sleep(600);
    expect(daemon.state().heartbeat).toBeGreaterThanOrEqual(before);
    await expect(gateway.send('ping')).resolves.toMatchObject({ pong: true });
  });

  it('survit à des redémarrages répétés du serveur web', async () => {
    const daemon = buildDaemon();
    daemon.start();
    await waitFor(() => existsSync(fanSocketPath(env.config)), 5000, 'socket du daemon');

    for (let restart = 0; restart < 3; restart++) {
      const gateway = new FanGateway(withEmbedded('never'), null);
      const decision = startEmbeddedFanHost(withEmbedded('never'), () => buildWebCandidate());
      expect(decision.host).toBeNull();

      await expect(gateway.send('ping')).resolves.toMatchObject({ pong: true });
      expect(gateway.online()).toBe(true);

      // « Arrêt » du serveur web : aucun fichier du runtime ne doit disparaître.
      expect(existsSync(fanSocketPath(env.config))).toBe(true);
      expect(existsSync(lockPath(env.config.storage.runtimeDir))).toBe(true);
      expect(existsSync(fanStatePath(env.config))).toBe(true);
    }

    // Le daemon répond toujours après les trois cycles.
    await expect(new FanGateway(env.config, null).send('ping')).resolves.toMatchObject({ pong: true });
  });

  it('fait cohabiter socket, verrou et fichier d’état dans le même répertoire', async () => {
    const daemon = buildDaemon();
    daemon.start();
    await waitFor(() => existsSync(fanStatePath(env.config)), 5000, 'fichier d’état');

    const dir = env.config.storage.runtimeDir;
    expect(fanSocketPath(env.config)).toBe(join(dir, 'fand.sock'));
    expect(lockPath(dir)).toBe(join(dir, 'fan-engine.lock'));
    expect(fanStatePath(env.config)).toBe(join(dir, 'fand-state.json'));
    for (const path of [fanSocketPath(env.config), lockPath(dir), fanStatePath(env.config)]) {
      expect(existsSync(path)).toBe(true);
    }
  });
});

// =====================================================================
// Verrou
// =====================================================================

describe('verrou du moteur', () => {
  it('reprend un verrou orphelin laissé par un processus mort', () => {
    const dir = join(env.dir, 'orphan-run');
    mkdirSync(dir, { recursive: true });
    // PID hors de portée du système : le détenteur supposé n'existe pas.
    writeFileSync(lockPath(dir), '4194304');

    const attempt = acquireFanLock(dir);
    expect(attempt.acquired).toBe(true);
    expect(readFileSync(lockPath(dir), 'utf8').trim()).toBe(String(process.pid));
    attempt.lock?.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it('détecte un verrou vivant et refuse de le reprendre', () => {
    const dir = join(env.dir, 'live-run');
    mkdirSync(dir, { recursive: true });
    // Le processus courant est bien vivant : le verrou doit être respecté.
    writeFileSync(lockPath(dir), String(process.pid));

    const attempt = acquireFanLock(dir);
    expect(attempt.acquired).toBe(false);
    expect(attempt.heldBy).toBe(process.pid);
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it('libère le verrou à l’arrêt pour permettre la reprise par un autre moteur', async () => {
    const daemon = buildDaemon();
    daemon.start();
    expect(existsSync(lockPath(env.config.storage.runtimeDir))).toBe(true);

    await daemon.stop();
    expect(existsSync(lockPath(env.config.storage.runtimeDir))).toBe(false);

    const next = buildDaemon();
    expect(next.start().started).toBe(true);
  });
});

// =====================================================================
// Configuration livrée / défaut logiciel
// =====================================================================

describe('configuration', () => {
  it('livre `embedded: never` dans packaging/config.example.yaml', () => {
    const loaded = loadConfig(PACKAGED_CONFIG);
    expect(loaded.sourceFile).toBe(PACKAGED_CONFIG);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.fanControl.embedded).toBe('never');
  });

  it('conserve `auto` comme défaut logiciel (développement, démo, mono-processus)', () => {
    expect(configSchema.parse({}).fanControl.embedded).toBe('auto');
  });

  it('laisse le contrôle PWM inactif dans la configuration livrée', () => {
    const config = loadConfig(PACKAGED_CONFIG).config;
    // Aucune sortie ne peut passer sous contrôle logiciel sans retour BIOS validé,
    // c'est-à-dire sans avoir traversé la calibration guidée.
    expect(config.fanControl.requireBiosReturnValidation).toBe(true);
  });

  it('donne la priorité aux variables d’environnement sur le fichier YAML', () => {
    const yamlPath = join(env.dir, 'config.yaml');
    writeFileSync(yamlPath, [
      'server:',
      '  port: 4321',
      'mode:',
      '  type: hardware',
      'storage:',
      '  runtime_dir: /run/pcia-control-center',
      'logging:',
      '  level: info',
    ].join('\n'));

    const fromFile = loadConfig(yamlPath).config;
    expect(fromFile.server.port).toBe(4321);
    expect(fromFile.mode.type).toBe('hardware');

    const saved = { ...process.env };
    try {
      process.env.PCIA_PORT = '8080';
      process.env.PCIA_MODE = 'demo';
      process.env.PCIA_RUNTIME_DIR = join(env.dir, 'run-env');
      process.env.PCIA_LOG_LEVEL = 'debug';
      const overridden = loadConfig(yamlPath).config;
      expect(overridden.server.port).toBe(8080);
      expect(overridden.mode.type).toBe('demo');
      expect(overridden.storage.runtimeDir).toBe(join(env.dir, 'run-env'));
      expect(overridden.logging.level).toBe('debug');
    } finally {
      process.env = saved;
    }
  });
});

// =====================================================================
// Aucune activation automatique du PWM
// =====================================================================

describe('aucune activation automatique du PWM', () => {
  it('laisse toutes les sorties au BIOS sur une base non calibrée', async () => {
    const daemon = buildDaemon();
    daemon.start();
    // Plusieurs cycles de régulation : rien ne doit basculer tout seul.
    for (let i = 0; i < 10; i++) {
      env.world.step();
      await sleep(40);
    }

    for (const output of env.hwmon.cached().pwmOutputs) {
      expect(output.currentEnableMode).toBe(SIM_MODE_BIOS);
      expect(env.hwmon.readEnableMode(output.key)).toBe(SIM_MODE_BIOS);
    }
    for (const output of daemon.state().outputs) {
      expect(output.controlState).toBe('BIOS_CONTROLLED');
    }
  });

  it('n’active aucun PWM à la découverte demandée par l’interface', () => {
    const daemon = buildDaemon();
    daemon.start();
    const discovery = daemon.calibration.discover();
    expect(discovery.pwmOutputs.length).toBeGreaterThan(0);
    for (const output of discovery.pwmOutputs) {
      expect(output.currentEnableMode).toBe(SIM_MODE_BIOS);
    }
  });

  it('n’écrit jamais dans un fichier pwm* depuis le script d’installation', () => {
    const install = readFileSync(join(REPO_ROOT, 'packaging', 'install.sh'), 'utf8');
    // Le script ne doit contenir aucune écriture vers /sys/class/hwmon.
    expect(install).not.toMatch(/>\s*\/sys\/class\/hwmon/);
    expect(install).not.toMatch(/tee\s+\/sys\/class\/hwmon/);
    // Le déclenchement udev doit cibler l'action « add », seule reconnue par la règle.
    expect(install).toContain('udevadm trigger --action=add --subsystem-match=hwmon');
  });

  it('n’écrit dans aucun pwm*_enable depuis la règle udev', () => {
    const rules = readFileSync(join(REPO_ROOT, 'packaging', 'udev', '99-pcia-hwmon.rules'), 'utf8');
    // La règle ne fait qu'ajuster groupe et droits : chgrp / chmod, rien d'autre.
    expect(rules).toContain('chgrp pcia');
    expect(rules).toContain('chmod g+w');
    expect(rules).not.toMatch(/echo\s+\d+\s*>/);
  });
});

// =====================================================================
// Unités systemd livrées
// =====================================================================

describe('unités systemd', () => {
  const unit = (name: string) => readFileSync(join(REPO_ROOT, 'packaging', 'systemd', name), 'utf8');

  /** Directives effectives d'une section (`[Unit]`, `[Service]`, …), commentaires
   *  et lignes vides exclus : ce sont elles seules que systemd interprète. */
  const directives = (content: string, name: string): string[] => {
    const lines: string[] = [];
    let current: string | null = null;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[') && line.endsWith(']')) {
        current = line.slice(1, -1);
        continue;
      }
      if (current !== name || !line || line.startsWith('#') || line.startsWith(';')) continue;
      lines.push(line);
    }
    return lines;
  };

  const section = (content: string, name: string): string => directives(content, name).join('\n');

  for (const name of ['pcia-control-center.service', 'pcia-fan-control.service']) {
    it(`déclare StartLimit* dans [Unit] pour ${name}`, () => {
      const content = unit(name);
      expect(section(content, 'Unit')).toContain('StartLimitIntervalSec=60');
      expect(section(content, 'Unit')).toContain('StartLimitBurst=5');
      expect(section(content, 'Service')).not.toContain('StartLimitIntervalSec');
      expect(section(content, 'Service')).not.toContain('StartLimitBurst');
    });

    it(`préserve le runtime partagé pour ${name}`, () => {
      const service = section(unit(name), 'Service');
      expect(service).toContain('RuntimeDirectory=pcia-control-center');
      expect(service).toContain('RuntimeDirectoryMode=0750');
      expect(service).toContain('RuntimeDirectoryPreserve=yes');
      expect(service).toContain('User=pcia');
      expect(service).toContain('Group=pcia');
    });
  }

  it('autorise AF_NETLINK au serveur web (os.networkInterfaces)', () => {
    const service = section(unit('pcia-control-center.service'), 'Service');
    expect(service).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK');
  });

  it('n’ouvre pas AF_NETLINK au daemon de ventilation', () => {
    const service = section(unit('pcia-fan-control.service'), 'Service');
    expect(service).toContain('RestrictAddressFamilies=AF_UNIX');
    expect(service).not.toContain('AF_NETLINK');
  });
});
