#!/usr/bin/env node
/** CLI d'administration `pcia-control-center`.
 *
 *  Conçue pour fonctionner **sans interface web** : diagnostic, état, et
 *  surtout `return-to-bios`, qui doit rester utilisable si le serveur est
 *  arrêté ou si le navigateur est inaccessible.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fanSocketPath, fanStatePath, loadConfig, resolveWritablePaths } from './config.js';
import { createLogger, setLogFormat, setLogLevel } from './logger.js';
import { openAndMigrate } from './db/database.js';
import { createRepositories, seedDefaults } from './db/repositories.js';
import { FanIpcClient, readStateFile } from './fan/ipc.js';
import { canWriteDir, createRuntimeEnv } from './runtime.js';
import { readSystemInfo } from './system/info.js';
import { hasTool, KNOWN_TOOLS } from './system/exec.js';
import { FAN_IDS } from './contract.js';
import { defaultFanConfigs, DEFAULT_PROFILE_ID } from './fan/defaults.js';

const log = createLogger('cli');

const USAGE = `
pcia-control-center — outil d'administration

Usage : pcia-control-center <commande> [options]

Commandes :
  status                 État du back-end et du moteur de ventilation
  discover               Inventaire des contrôleurs hwmon et des sorties PWM
  diagnostics [fichier]  Rapport de diagnostic complet (JSON, sans secret)
  fans                   État courant des sorties de ventilation
  return-to-bios [ID]    Restitue une sortie (ou toutes) au contrôle BIOS
  export-config <fichier>  Exporte la configuration au format JSON
  import-config <fichier>  Importe une configuration exportée
  reset-demo             Réinitialise les scénarios et données de démonstration
  help                   Affiche cette aide

Options globales :
  --config <fichier>     Chemin du fichier de configuration YAML
  --json                 Sortie brute JSON (pour les scripts)

Note : « return-to-bios » agit sur le matériel. Elle n'est exécutée que si le
moteur de ventilation répond, et journalise systématiquement son résultat.
`;

interface Args {
  command: string;
  positional: string[];
  json: boolean;
  configPath?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let json = false;
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--config') configPath = argv[++i];
    else positional.push(arg);
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), json, configPath };
}

function output(args: Args, data: unknown, text: () => string): void {
  if (args.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${text()}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`Erreur : ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const loaded = loadConfig(args.configPath);
  const resolved = resolveWritablePaths(loaded.config, canWriteDir);
  const config = resolved.config;
  setLogLevel(args.json ? 'error' : config.logging.level);
  setLogFormat('text');

  const client = new FanIpcClient(fanSocketPath(config));

  switch (args.command) {
    // -----------------------------------------------------------------
    case 'status': {
      const info = readSystemInfo();
      const state = readStateFile(fanStatePath(config));
      const online = state !== null && Date.now() - state.heartbeat <= config.fanControl.heartbeatTimeoutMs;
      const data = {
        version: '1.0.0',
        // `mode.type` peut valoir `auto` : le mode réellement retenu n'est connu
        // que du moteur, qui le publie dans son fichier d'état.
        configuredMode: config.mode.type,
        mode: state?.mode ?? config.mode.type,
        server: `http://${config.server.host}:${config.server.port}/`,
        database: config.storage.databasePath,
        runtimeDir: config.storage.runtimeDir,
        host: info.hostname,
        kernel: info.kernel,
        distribution: info.distribution,
        fanEngine: {
          online,
          pid: state?.pid ?? null,
          lastHeartbeat: state ? new Date(state.heartbeat).toISOString() : null,
          failsafe: state?.failsafe ?? false,
          outputs: state?.outputs.map((o) => ({ id: o.id, state: o.controlState, pwm: o.pwm, rpm: o.rpm })) ?? [],
        },
      };
      output(args, data, () => [
        `PCIA Control Center ${data.version} — mode ${data.mode}`
        + (data.configuredMode === 'auto' ? ' (résolu automatiquement)' : ''),
        `Interface        : ${data.server}`,
        `Base             : ${data.database}`,
        `Machine          : ${data.host} · ${data.distribution} · noyau ${data.kernel}`,
        `Moteur ventilation : ${online ? `en ligne (pid ${data.fanEngine.pid})` : 'HORS LIGNE'}`,
        ...(state?.outputs ?? []).map(
          (o) => `  ${o.id.padEnd(9)} ${o.controlState.padEnd(20)} ${String(o.pwm).padStart(3)} %  ${o.rpm ?? '—'} RPM`,
        ),
      ].join('\n'));
      break;
    }

    // -----------------------------------------------------------------
    case 'discover': {
      const env = createRuntimeEnv(config);
      const discovery = env.hwmon.discover();
      output(args, discovery, () => [
        `Mode : ${env.mode}${env.degraded ? ' (dégradé)' : ''}`,
        ...env.degradedReasons.map((r) => `  ! ${r}`),
        '',
        'Contrôleurs :',
        ...discovery.controllers.map(
          (c) => `  ${c.driverName.padEnd(12)} pilote=${c.kernelDriver ?? '?'} bus=${c.bus ?? '?'} adresse=${c.address ?? '?'}\n    chemin actuel : ${c.currentPath}\n    empreinte     : ${c.key}`,
        ),
        '',
        'Sorties PWM :',
        ...discovery.pwmOutputs.map(
          (o) => `  ${o.key}\n    index=pwm${o.index} mode=${o.currentEnableMode ?? '—'} consigne=${o.currentPwm ?? '—'} % ` +
            `tach=${o.tachIndex ?? 'aucun'} rpm=${o.currentRpm ?? '—'} inscriptible=${o.writable ? 'oui' : 'NON'}`,
        ),
        '',
        'Capteurs de température :',
        ...discovery.tempSensors.map((s) => `  ${(s.label ?? `temp${s.index}`).padEnd(18)} ${s.valueC ?? '—'} °C   ${s.key}`),
        ...(discovery.warnings.length ? ['', 'Avertissements :', ...discovery.warnings.map((w) => `  ! ${w}`)] : []),
      ].join('\n'));
      break;
    }

    // -----------------------------------------------------------------
    case 'diagnostics': {
      const env = createRuntimeEnv(config);
      const discovery = env.hwmon.discover();
      const db = openAndMigrate(config.storage.databasePath);
      const repos = createRepositories(db);
      const info = readSystemInfo(true);
      const state = readStateFile(fanStatePath(config));

      const report = {
        generatedAt: new Date().toISOString(),
        application: { version: '1.0.0', mode: env.mode, degraded: env.degraded, degradedReasons: env.degradedReasons, node: process.version },
        system: {
          hostname: info.hostname, kernel: info.kernel, distribution: info.distribution,
          bios: info.biosVersion, board: [info.boardVendor, info.boardName].filter(Boolean).join(' ') || null,
        },
        tools: Object.fromEntries(KNOWN_TOOLS.map((t) => [t, hasTool(t)])),
        hwmon: discovery,
        calibration: repos.calibration.list(),
        fanConfigs: repos.fanConfigs.list(),
        fanEngine: state,
        activeAlerts: repos.alerts.listActive().length,
        database: { path: config.storage.databasePath, historyPoints: repos.history.range(0).length },
        // Configuration anonymisée : aucun jeton n'est inclus.
        configuration: { ...config, security: { ...config.security, token: undefined } },
      };
      db.close();

      const target = args.positional[0];
      if (target) {
        writeFileSync(target, JSON.stringify(report, null, 2));
        process.stdout.write(`Rapport écrit dans ${target}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      break;
    }

    // -----------------------------------------------------------------
    case 'fans': {
      const state = readStateFile(fanStatePath(config));
      if (!state) fail('Moteur de ventilation injoignable (aucun fichier d’état).');
      const db = openAndMigrate(config.storage.databasePath);
      const repos = createRepositories(db);
      const configs = new Map(repos.fanConfigs.list().map((c) => [c.id, c]));
      const calibrations = new Map(repos.calibration.list().map((c) => [c.fanId, c]));
      db.close();

      output(args, state, () => [
        `Moteur : ${state.mode}, boucle ${state.loopIntervalMs} ms${state.failsafe ? ' — MODE SÉCURITÉ' : ''}`,
        '',
        ...state.outputs.map((o) => {
          const cfg = configs.get(o.id);
          const cal = calibrations.get(o.id);
          return [
            `${o.id} — ${cfg?.displayName ?? ''}`,
            `  contrôle    : ${o.controlState}`,
            `  calibration : ${cal?.state ?? 'inconnue'}${cal?.invalidatedReason ? ` (${cal.invalidatedReason})` : ''}`,
            `  retour BIOS : ${cal?.biosReturn ?? 'non testé'}`,
            `  consigne    : ${o.pwm} % (demandée ${o.requestedPwm} %)`,
            `  rotation    : ${o.rpm ?? '—'} RPM${o.stalled ? '  ⚠ BLOQUÉ' : ''}`,
            `  référence   : ${o.refTemp ?? '—'} °C`,
            ...(o.lastWriteError ? [`  erreur      : ${o.lastWriteError}`] : []),
          ].join('\n');
        }),
      ].join('\n'));
      break;
    }

    // -----------------------------------------------------------------
    case 'return-to-bios': {
      const target = args.positional[0];
      const targets = target ? [target] : [...FAN_IDS];
      for (const id of targets) {
        if (!(FAN_IDS as readonly string[]).includes(id)) fail(`Sortie inconnue : ${id}`);
      }
      if (!client.available()) {
        fail('Moteur de ventilation injoignable : impossible de restituer les sorties.\n'
          + 'Si le moteur est arrêté, les sorties sont déjà sous contrôle BIOS ou figées sur\n'
          + 'leur dernière consigne — voir la section « Limites connues » du README.');
      }

      const results: Record<string, unknown> = {};
      for (const id of targets) {
        try {
          results[id] = await client.request('returnToBios', { fanId: id });
          log.info('Sortie restituée au BIOS', { fanId: id });
        } catch (err) {
          results[id] = { ok: false, error: (err as Error).message };
          log.error('Restitution impossible', { fanId: id, error: (err as Error).message });
        }
      }
      output(args, results, () => Object.entries(results)
        .map(([id, r]) => `${id} : ${(r as { ok: boolean }).ok ? 'restituée au BIOS' : `ÉCHEC — ${(r as { error?: string }).error ?? 'non confirmé'}`}`)
        .join('\n'));
      break;
    }

    // -----------------------------------------------------------------
    case 'export-config': {
      const target = args.positional[0];
      if (!target) fail('Chemin de destination manquant : pcia-control-center export-config <fichier>');
      const db = openAndMigrate(config.storage.databasePath);
      const repos = createRepositories(db);
      const payload = {
        version: 1,
        application: 'pcia-control-center',
        exportedAt: new Date().toISOString(),
        fanConfigs: repos.fanConfigs.list(),
        profiles: repos.profiles.list(),
        activeProfileId: repos.settings.get<string>('activeProfileId', DEFAULT_PROFILE_ID),
        groups: repos.groups.list(),
        manualServices: repos.services.listManual(),
        manualConnections: repos.connections.listManual(),
        serviceOverrides: repos.services.listOverrides(),
        connectionOverrides: repos.connections.listOverrides(),
        sensorOverrides: repos.settings.get('sensorOverrides', {}),
        calibration: repos.calibration.list(),
        uiState: repos.settings.get<Record<string, unknown> | null>('uiState', null),
      };
      db.close();
      writeFileSync(target, JSON.stringify(payload, null, 2));
      process.stdout.write(`Configuration exportée dans ${target}\n`);
      break;
    }

    // -----------------------------------------------------------------
    case 'import-config': {
      const source = args.positional[0];
      if (!source) fail('Fichier source manquant : pcia-control-center import-config <fichier>');
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(readFileSync(source, 'utf8')) as Record<string, any>;
      } catch (err) {
        fail(`Fichier illisible : ${(err as Error).message}`);
      }
      if (payload.application !== 'pcia-control-center') {
        fail('Ce fichier n’est pas un export PCIA Control Center.');
      }
      const db = openAndMigrate(config.storage.databasePath);
      const repos = createRepositories(db);
      seedDefaults(repos);

      // Validation avant écriture : import tout-ou-rien.
      const { validateCurve } = await import('./fan/curve.js');
      const errors: string[] = [];
      for (const cfg of payload.fanConfigs ?? []) {
        const validation = validateCurve(cfg.curve);
        if (!validation.ok) errors.push(`${cfg.id} : ${validation.errors.join(' ')}`);
      }
      if (errors.length) {
        db.close();
        fail(`Import refusé :\n  ${errors.join('\n  ')}`);
      }

      const run = db.transaction(() => {
        if (payload.fanConfigs?.length) repos.fanConfigs.replaceAll(payload.fanConfigs);
        for (const p of payload.profiles ?? []) if (!p.builtin) repos.profiles.upsert(p);
        if (payload.groups) repos.groups.replaceAll(payload.groups);
        if (payload.activeProfileId) repos.settings.set('activeProfileId', payload.activeProfileId);
        if (payload.sensorOverrides) repos.settings.set('sensorOverrides', payload.sensorOverrides);
        if (payload.uiState) repos.settings.set('uiState', payload.uiState);
        // La calibration n'est PAS importée : elle décrit le matériel de la
        // machine d'origine et doit être refaite ici.
      });
      run();
      db.close();
      process.stdout.write(
        'Configuration importée.\n'
        + 'La calibration n’a volontairement pas été importée : elle est propre au matériel.\n',
      );
      break;
    }

    // -----------------------------------------------------------------
    case 'reset-demo': {
      const db = openAndMigrate(config.storage.databasePath);
      const repos = createRepositories(db);
      const run = db.transaction(() => {
        db.prepare('DELETE FROM connection_conflicts').run();
        db.prepare('DELETE FROM connection_overrides').run();
        db.prepare('DELETE FROM service_overrides').run();
        db.prepare('DELETE FROM manual_services').run();
        db.prepare('DELETE FROM manual_connections').run();
        db.prepare('DELETE FROM history').run();
        db.prepare('DELETE FROM history_markers').run();
        db.prepare('DELETE FROM events').run();
        db.prepare('DELETE FROM alerts').run();
        repos.fanConfigs.replaceAll(defaultFanConfigs());
        repos.profiles.restoreBuiltins();
        repos.settings.set('activeProfileId', DEFAULT_PROFILE_ID);
        repos.settings.delete('uiState');
        repos.settings.delete('demoCalibrationSeeded');
        // La calibration simulée est effacée pour être régénérée au démarrage.
        if (config.mode.type === 'demo') db.prepare('DELETE FROM calibration').run();
      });
      run();
      db.close();
      process.stdout.write('Données de démonstration réinitialisées.\n');
      break;
    }

    default:
      process.stderr.write(`Commande inconnue : ${args.command}\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Erreur : ${(err as Error).message}\n`);
  process.exit(1);
});
