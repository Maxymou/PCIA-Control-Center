/** Persistance SQLite : migrations, corrections prioritaires, conflits, notes. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentSchemaVersion, migrate, openDatabase, SCHEMA_VERSION } from '../src/db/database.js';
import { createRepositories, seedDefaults } from '../src/db/repositories.js';
import { DiscoveryTracker } from '../src/discovery/merge.js';
import type { DetectedConnection, DetectedService } from '../src/discovery/model.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(() => { env = createTestEnv(); });
afterEach(() => { env.cleanup(); });

describe('migrations', () => {
  it('crée le schéma courant et reste idempotente', () => {
    const db = openDatabase({ path: ':memory:', skipMkdir: true });
    expect(currentSchemaVersion(db)).toBe(0);

    const first = migrate(db);
    // Toutes les migrations connues, dans l'ordre — pas seulement la dernière :
    // une base neuve les traverse toutes depuis la version 0.
    expect(first.applied).toEqual([1, 2]);
    expect(first.applied[first.applied.length - 1]).toBe(SCHEMA_VERSION);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const second = migrate(db);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('migration 2 (monitoring_only) : ajoutée sur une base existante sans perte de données, idempotente', () => {
    const db = openDatabase({ path: ':memory:', skipMkdir: true });
    // Reproduit une base restée à la version 1 (schéma d'origine, sans la
    // colonne), avec une ligne fan_configs déjà présente — comme une
    // installation antérieure à ce correctif.
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial', 0);
      CREATE TABLE fan_configs (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, assigned_hardware TEXT NOT NULL,
        custom_hardware_label TEXT, sensor TEXT NOT NULL, mode TEXT NOT NULL,
        manual_pwm INTEGER NOT NULL, min_pwm INTEGER NOT NULL, warn_rpm INTEGER NOT NULL,
        curve TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO fan_configs (id, display_name, assigned_hardware, sensor, mode, manual_pwm, min_pwm, warn_rpm, curve, updated_at)
       VALUES ('CPU_FAN1', 'Ventirad CPU', 'cpu', '{}', 'auto', 40, 15, 300, '[]', 1234)`,
    ).run();

    expect(currentSchemaVersion(db)).toBe(1);
    const result = migrate(db);
    expect(result.applied).toEqual([2]);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const row = db.prepare('SELECT * FROM fan_configs WHERE id = ?').get('CPU_FAN1') as Record<string, unknown>;
    expect(row.monitoring_only).toBe(0); // défaut : n'active rien automatiquement
    expect(row.display_name).toBe('Ventirad CPU'); // donnée existante intacte
    expect(row.updated_at).toBe(1234);

    // Idempotente : rejouer migrate() ne change plus rien.
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });

  it('amorce les profils prédéfinis et les sorties par défaut', () => {
    const profiles = env.repos.profiles.list();
    expect(profiles.filter((p) => p.builtin).map((p) => p.id).sort())
      .toEqual(['p-balanced', 'p-max', 'p-perf', 'p-silent']);
    expect(env.repos.fanConfigs.list()).toHaveLength(5);
  });

  it('n’amorce aucune calibration : tout démarre sous contrôle BIOS', () => {
    for (const record of env.repos.calibration.list()) {
      expect(record.state).toBe('NOT_CALIBRATED');
    }
  });

  it('réinjecte un profil prédéfini supprimé au démarrage suivant', () => {
    env.repos.db.prepare('DELETE FROM fan_profiles WHERE id = ?').run('p-silent');
    seedDefaults(env.repos);
    expect(env.repos.profiles.get('p-silent')).not.toBeNull();
  });
});

describe('services manuels et corrections', () => {
  it('crée, modifie et supprime un service manuel', () => {
    const created = env.repos.services.createManual({
      name: 'mon-service', type: 'api', status: 'running', port: 9999,
    } as never);
    expect(env.repos.services.listManual()).toHaveLength(1);

    env.repos.services.updateManual(created.id, { note: 'Ajouté à la main' });
    expect(env.repos.services.listManual()[0].note).toBe('Ajouté à la main');

    expect(env.repos.services.deleteManual(created.id)).toBe(true);
    expect(env.repos.services.listManual()).toHaveLength(0);
  });

  it('conserve les notes et masquages d’un service détecté', () => {
    env.repos.services.setOverride('svc-abc', { displayName: 'Nom choisi' }, { note: 'Note utile' });
    env.repos.services.setHidden('svc-abc', true);

    const override = env.repos.services.listOverrides()[0];
    expect(override.patch.displayName).toBe('Nom choisi');
    expect(override.note).toBe('Note utile');
    expect(override.hidden).toBe(true);
  });
});

describe('corrections de connexions', () => {
  it('capture la détection d’origine à la première correction seulement', () => {
    const original = { sourceId: 'a', targetId: 'b', type: 'http' as const, port: 80, endpoint: '/v1' };
    env.repos.connections.setCorrection('cx-1', { sourceId: 'b', targetId: 'a' }, original);
    // Une seconde correction ne doit pas écraser la détection d'origine.
    env.repos.connections.setCorrection('cx-1', { port: 8080 }, {
      sourceId: 'x', targetId: 'y', type: 'https', port: 443,
    });

    const override = env.repos.connections.getOverride('cx-1')!;
    expect(override.detectedOriginal).toEqual(original);
    expect(override.patch.sourceId).toBe('b');
    expect(override.patch.port).toBe(8080);
  });

  it('conserve la note quand la correction est abandonnée', () => {
    env.repos.connections.setCorrection('cx-2', { sourceId: 'b' }, null);
    env.repos.connections.setNote('cx-2', 'À vérifier');
    env.repos.connections.clearCorrection('cx-2');

    const override = env.repos.connections.getOverride('cx-2')!;
    expect(override.note).toBe('À vérifier');
    expect(override.patch).toEqual({});
  });

  it('résout un conflit en conservant la correction', () => {
    env.repos.connections.setCorrection('cx-3', { sourceId: 'b', targetId: 'a' }, null);
    env.repos.connections.recordConflict('cx-3', { sourceId: 'a', targetId: 'b', type: 'http' });
    expect(env.repos.connections.listConflicts()).toHaveLength(1);

    env.repos.connections.resolveConflict('cx-3', false);
    expect(env.repos.connections.listConflicts()).toHaveLength(0);
    // La correction survit à l'arbitrage.
    expect(env.repos.connections.getOverride('cx-3')!.patch.sourceId).toBe('b');
  });

  it('résout un conflit en acceptant la détection', () => {
    env.repos.connections.setCorrection('cx-4', { sourceId: 'b', targetId: 'a' }, null);
    env.repos.connections.recordConflict('cx-4', { sourceId: 'a', targetId: 'b', type: 'http' });

    env.repos.connections.resolveConflict('cx-4', true);
    const override = env.repos.connections.getOverride('cx-4');
    expect(override === null || Object.keys(override.patch).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Fusion détection ↔ configuration
// ---------------------------------------------------------------------

function detectedService(id: string, overrides: Partial<DetectedService> = {}): DetectedService {
  return {
    id, name: id, displayName: id, type: 'api', status: 'running',
    origin: 'detected', lastCheck: Date.now(),
    source: 'systemd', category: 'application', hiddenByDefault: false,
    pid: null, systemdUnit: null, dockerContainer: null, dockerImage: null,
    ports: [], startedAt: null, uptimeSeconds: null, cpuPercent: null, memoryMb: null,
    metadata: {}, ...overrides,
  };
}

function detectedConnection(id: string, sourceId: string, targetId: string, overrides: Partial<DetectedConnection> = {}): DetectedConnection {
  return {
    id, sourceId, targetId, type: 'http', status: 'active', origin: 'detected',
    confidence: 0.95, lastActivity: Date.now(), direction: 'outbound',
    detectionMethod: 'tcp-socket', confidenceLevel: 'HIGH', remoteAddress: '127.0.0.1',
    lastObserved: Date.now(), hiddenByDefault: false, metadata: {}, ...overrides,
  };
}

describe('DiscoveryTracker', () => {
  it('ne marque rien comme nouveau au premier cycle', () => {
    const tracker = new DiscoveryTracker();
    const services = [detectedService('a'), detectedService('b')];
    const result = tracker.merge(services, [], env.repos);
    expect(result.services.every((s) => !s.isNew)).toBe(true);
    expect(result.appearedServices).toHaveLength(0);
  });

  it('signale un service apparu après la référence', () => {
    const tracker = new DiscoveryTracker();
    tracker.merge([detectedService('a')], [], env.repos);
    const result = tracker.merge([detectedService('a'), detectedService('b')], [], env.repos);
    expect(result.appearedServices.map((s) => s.id)).toEqual(['b']);
    expect(result.services.find((s) => s.id === 'b')!.isNew).toBe(true);
  });

  it('signale un changement d’état de service', () => {
    const tracker = new DiscoveryTracker();
    tracker.merge([detectedService('a')], [], env.repos);
    const result = tracker.merge([detectedService('a', { status: 'crashed' })], [], env.repos);
    expect(result.serviceTransitions).toHaveLength(1);
    expect(result.serviceTransitions[0].to).toBe('crashed');
  });

  it('marque une connexion disparue comme perdue au lieu de la retirer', () => {
    const tracker = new DiscoveryTracker();
    const services = [detectedService('a'), detectedService('b')];
    tracker.merge(services, [detectedConnection('cx', 'a', 'b')], env.repos);

    const result = tracker.merge(services, [], env.repos);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].status).toBe('lost');
    expect(result.lostConnections).toHaveLength(1);
  });

  it('donne la priorité à la correction et ouvre un conflit sur contradiction', () => {
    const tracker = new DiscoveryTracker();
    const services = [detectedService('a'), detectedService('b')];
    const detected = detectedConnection('cx', 'a', 'b');
    tracker.merge(services, [detected], env.repos);

    // L'utilisateur inverse le sens.
    env.repos.connections.setCorrection('cx', { sourceId: 'b', targetId: 'a' }, {
      sourceId: 'a', targetId: 'b', type: 'http',
    });

    const result = tracker.merge(services, [detected], env.repos);
    const merged = result.connections.find((c) => c.id === 'cx')!;
    // La correction gagne...
    expect(merged.sourceId).toBe('b');
    expect(merged.origin).toBe('corrected');
    expect(merged.detectedOriginal).toEqual({ sourceId: 'a', targetId: 'b', type: 'http' });
    // ...et le désaccord est enregistré pour arbitrage.
    expect(result.newConflicts).toContain('cx');
    expect(result.conflicts).toHaveLength(1);
  });

  it('n’affiche pas une connexion dont une extrémité a disparu', () => {
    const tracker = new DiscoveryTracker();
    tracker.merge([detectedService('a'), detectedService('b')], [detectedConnection('cx', 'a', 'b')], env.repos);
    const result = tracker.merge([detectedService('a')], [detectedConnection('cx', 'a', 'b')], env.repos);
    expect(result.connections).toHaveLength(0);
  });

  it('masque les connexions de faible confiance sauf demande explicite', () => {
    const tracker = new DiscoveryTracker();
    const services = [detectedService('a'), detectedService('b')];
    const weak = detectedConnection('cx-weak', 'a', 'b', {
      confidenceLevel: 'LOW', confidence: 0.35, hiddenByDefault: true, detectionMethod: 'docker-network',
    });
    expect(tracker.merge(services, [weak], env.repos).connections).toHaveLength(0);
    expect(tracker.merge(services, [weak], env.repos, { includeLowConfidence: true }).connections).toHaveLength(1);
  });

  it('masque les services système sauf demande explicite', () => {
    const tracker = new DiscoveryTracker();
    const services = [detectedService('sys', { category: 'system', hiddenByDefault: true })];
    expect(tracker.merge(services, [], env.repos).services).toHaveLength(0);
    expect(tracker.merge(services, [], env.repos, { includeHidden: true }).services).toHaveLength(1);
  });
});

describe('historique', () => {
  it('enregistre, relit et purge les points', () => {
    const now = Date.now();
    env.repos.history.append({ t: now - 120_000, temps: { cpu: 50 }, rpm: { CPU_FAN1: 800 }, pwm: { CPU_FAN1: 40 } });
    env.repos.history.append({ t: now, temps: { cpu: 52 }, rpm: { CPU_FAN1: 850 }, pwm: { CPU_FAN1: 42 } });

    const range = env.repos.history.range(now - 60_000);
    expect(range).toHaveLength(1);
    expect(range[0].temps.cpu).toBe(52);

    expect(env.repos.history.purgeOlderThan(now - 60_000)).toBe(1);
    expect(env.repos.history.range(0)).toHaveLength(1);
  });

  it('conserve les repères d’événements', () => {
    env.repos.history.addMarker({ t: Date.now(), label: 'Profil : Silencieux', kind: 'profile' });
    expect(env.repos.history.markers(Date.now() - 60_000)).toHaveLength(1);
  });
});

describe('alertes', () => {
  const input = {
    type: 'HIGH_TEMPERATURE' as const, level: 'warning' as const, targetKind: 'hardware' as const,
    targetId: 'cpu', targetLabel: 'CPU', message: 'Température élevée',
  };

  it('ne crée pas de doublon pour une cause identique', () => {
    const first = env.repos.alerts.raise({ ...input, value: '80 °C' });
    const second = env.repos.alerts.raise({ ...input, value: '82 °C' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(env.repos.alerts.listActive()).toHaveLength(1);
    // La valeur courante est tenue à jour sur l'alerte existante.
    expect(env.repos.alerts.get(second.alert.id)!.value).toBe('82 °C');
  });

  it('reste active après acquittement tant que la cause existe', () => {
    const { alert } = env.repos.alerts.raise(input);
    env.repos.alerts.acknowledge(alert.id);
    const acknowledged = env.repos.alerts.get(alert.id)!;
    expect(acknowledged.acknowledged).toBe(true);
    expect(acknowledged.active).toBe(true);
  });

  it('se résout quand la cause disparaît', () => {
    env.repos.alerts.raise(input);
    env.repos.alerts.resolve('hardware', 'cpu', 'HIGH_TEMPERATURE');
    expect(env.repos.alerts.listActive()).toHaveLength(0);
  });

  it('gère la mise en sommeil', () => {
    const { alert } = env.repos.alerts.raise(input);
    const snoozed = env.repos.alerts.snooze(alert.id, 15)!;
    expect(snoozed.snoozedUntil).toBeGreaterThan(Date.now());
    expect(env.repos.alerts.unsnooze(alert.id)!.snoozedUntil).toBeUndefined();
  });
});

describe('configuration de ventilation', () => {
  it('incrémente la révision à chaque écriture pour réveiller le moteur', () => {
    const before = env.repos.fanConfigs.revision();
    const config = env.repos.fanConfigs.get('CPU_FAN1')!;
    env.repos.fanConfigs.upsert({ ...config, manualPwm: 55 });
    expect(env.repos.fanConfigs.revision()).toBeGreaterThan(before);
  });

  it('renvoie les valeurs par défaut pour une sortie absente en base', () => {
    env.repos.db.prepare('DELETE FROM fan_configs').run();
    const list = env.repos.fanConfigs.list();
    expect(list).toHaveLength(5);
    expect(list[0].id).toBe('CPU_FAN1');
  });
});
