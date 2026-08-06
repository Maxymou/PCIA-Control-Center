/** Accès SQLite et migrations.
 *
 *  La base est l'unique source de vérité pour la configuration : elle est écrite
 *  par l'API et relue (en lecture seule) par le moteur de ventilation, qui reste
 *  ainsi opérationnel même si l'API est arrêtée.
 */

import BetterSqlite3, { type Database as Sqlite } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('db');

export type Db = Sqlite;

interface Migration {
  version: number;
  name: string;
  up: string;
}

/** Migrations forward-only. Ne jamais modifier une migration déjà publiée :
 *  en ajouter une nouvelle. */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE manual_services (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        display_name        TEXT,
        type                TEXT NOT NULL,
        status              TEXT NOT NULL,
        version             TEXT,
        port                INTEGER,
        address             TEXT,
        process             TEXT,
        container           TEXT,
        note                TEXT,
        metadata            TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      -- Corrections et masquages appliqués aux services détectés.
      CREATE TABLE service_overrides (
        service_id  TEXT PRIMARY KEY,
        patch       TEXT NOT NULL,          -- JSON Partial<Service>
        hidden      INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE manual_connections (
        id           TEXT PRIMARY KEY,
        source_id    TEXT NOT NULL,
        target_id    TEXT NOT NULL,
        type         TEXT NOT NULL,
        protocol     TEXT,
        port         INTEGER,
        endpoint     TEXT,
        status       TEXT NOT NULL,
        note         TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      -- Une correction manuelle est prioritaire sur toute détection ultérieure.
      CREATE TABLE connection_overrides (
        connection_id      TEXT PRIMARY KEY,
        patch              TEXT NOT NULL,   -- JSON Partial<Connection>
        detected_original  TEXT,            -- JSON snapshot de la détection d'origine
        hidden             INTEGER NOT NULL DEFAULT 0,
        note               TEXT,
        updated_at         INTEGER NOT NULL
      );

      CREATE TABLE connection_conflicts (
        connection_id  TEXT PRIMARY KEY,
        detected       TEXT NOT NULL,       -- JSON de la nouvelle observation
        created_at     INTEGER NOT NULL,
        resolved_at    INTEGER,
        resolution     TEXT                 -- 'kept-correction' | 'accepted-detection'
      );

      CREATE TABLE service_groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        service_ids TEXT NOT NULL,          -- JSON string[]
        color       TEXT,
        note        TEXT,
        collapsed   INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE fan_configs (
        id                    TEXT PRIMARY KEY,
        display_name          TEXT NOT NULL,
        assigned_hardware     TEXT NOT NULL,
        custom_hardware_label TEXT,
        sensor                TEXT NOT NULL,  -- JSON SensorRef
        mode                  TEXT NOT NULL,
        manual_pwm            INTEGER NOT NULL,
        min_pwm               INTEGER NOT NULL,
        warn_rpm              INTEGER NOT NULL,
        curve                 TEXT NOT NULL,  -- JSON CurvePoint[]
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE fan_profiles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        builtin     INTEGER NOT NULL DEFAULT 0,
        curves      TEXT NOT NULL,           -- JSON Record<FanId, CurvePoint[]>
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE calibration (
        fan_id                      TEXT PRIMARY KEY,
        state                       TEXT NOT NULL,
        output_key                  TEXT,
        controller_key              TEXT,
        controller_driver           TEXT,
        controller_address          TEXT,
        pwm_index                   INTEGER,
        tach_index                  INTEGER,
        last_pwm_path               TEXT,
        last_tach_path              TEXT,
        assigned_hardware           TEXT,
        custom_hardware_label       TEXT,
        rpm_validation              TEXT,
        startup_pwm                 INTEGER,
        minimum_pwm                 INTEGER,
        min_rpm_observed            INTEGER,
        max_rpm_observed            INTEGER,
        software_control_validated  INTEGER NOT NULL DEFAULT 0,
        bios_return                 TEXT,
        bios_enable_mode            INTEGER,
        manual_enable_mode          INTEGER,
        bios_version                TEXT,
        kernel_version              TEXT,
        calibrated_at               INTEGER,
        notes                       TEXT,
        invalidated_reason          TEXT,
        updated_at                  INTEGER NOT NULL
      );

      CREATE TABLE alerts (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        level          TEXT NOT NULL,
        target_kind    TEXT NOT NULL,
        target_id      TEXT NOT NULL,
        target_label   TEXT NOT NULL,
        message        TEXT NOT NULL,
        value          TEXT,
        threshold      TEXT,
        recommendation TEXT,
        metadata       TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        active         INTEGER NOT NULL DEFAULT 1,
        acknowledged   INTEGER NOT NULL DEFAULT 0,
        snoozed_until  INTEGER
      );
      CREATE INDEX idx_alerts_active ON alerts(active, created_at DESC);
      CREATE INDEX idx_alerts_target ON alerts(target_kind, target_id, active);

      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        time          INTEGER NOT NULL,
        category      TEXT NOT NULL,
        level         TEXT NOT NULL,
        target_label  TEXT NOT NULL,
        message       TEXT NOT NULL,
        metadata      TEXT
      );
      CREATE INDEX idx_events_time ON events(time DESC);

      CREATE TABLE history (
        t      INTEGER PRIMARY KEY,
        temps  TEXT NOT NULL,               -- JSON Partial<Record<HardwareId, number>>
        rpm    TEXT NOT NULL,               -- JSON Partial<Record<FanId, number>>
        pwm    TEXT NOT NULL
      );

      CREATE TABLE history_markers (
        id     TEXT PRIMARY KEY,
        t      INTEGER NOT NULL,
        label  TEXT NOT NULL,
        kind   TEXT NOT NULL
      );
      CREATE INDEX idx_markers_time ON history_markers(t DESC);
    `,
  },
  {
    version: 2,
    name: 'fan_configs_monitoring_only',
    // Sortie connue comme non contrôlable en pratique (ex. pwm relié à la
    // carte mère uniquement par le tachymètre) : supervision RPM seule,
    // jamais proposée à l'autorisation. Caractéristique matérielle sur
    // `fan_configs`, pas un état de session — survit à toute réinitialisation
    // de `calibration`. Défaut 0 : n'active rien automatiquement sur aucune
    // installation existante.
    up: `
      ALTER TABLE fan_configs ADD COLUMN monitoring_only INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface OpenDbOptions {
  path: string;
  readOnly?: boolean;
  /** Ne crée pas les répertoires parents (utile pour les tests en mémoire). */
  skipMkdir?: boolean;
}

export function openDatabase(opts: OpenDbOptions): Db {
  if (!opts.skipMkdir && opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const db = new BetterSqlite3(opts.path, { readonly: opts.readOnly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!opts.readOnly) db.pragma('synchronous = NORMAL');
  return db;
}

/** Applique les migrations manquantes. Idempotent. */
export function migrate(db: Db): { from: number; to: number; applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  const from = row.v;
  const applied: number[] = [];
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
    });
    run();
    applied.push(migration.version);
    log.info('Migration appliquée', { version: migration.version, name: migration.name });
  }
  return { from, to: SCHEMA_VERSION, applied };
}

export function currentSchemaVersion(db: Db): number {
  try {
    const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
    return row.v;
  } catch {
    return 0;
  }
}

/** Ouvre la base et la met à jour. */
export function openAndMigrate(path: string): Db {
  const db = openDatabase({ path });
  migrate(db);
  return db;
}

export function jsonOrNull<T>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
