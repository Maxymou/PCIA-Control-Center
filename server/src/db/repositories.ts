/** Accès typé aux tables SQLite.
 *
 *  Toutes les écritures passent par ici : le reste du back-end ne construit
 *  jamais de SQL. Les repositories sont synchrones (better-sqlite3) — les
 *  volumes en jeu (quelques milliers de lignes) le permettent largement.
 */

import { randomUUID } from 'node:crypto';
import type {
  Alert, AppEvent, CalibrationRecord, Connection, ConnectionConflict, EventCategory,
  FanConfig, FanCurve, FanId, FanProfile, HardwareId, HistoryMarker, HistoryPoint,
  SensorRef, Service, ServiceGroup, Severity,
} from '../contract.js';
import { type Db, jsonOrNull } from './database.js';
import { builtinProfiles, defaultFanConfigs, DEFAULT_PROFILE_ID } from '../fan/defaults.js';

const now = () => Date.now();
export const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

// =====================================================================
// Réglages génériques (clé → JSON)
// =====================================================================

export class SettingsRepo {
  constructor(private db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    const parsed = jsonOrNull<T>(row.value);
    return parsed === null ? fallback : parsed;
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined;
  }

  set(key: string, value: unknown): void {
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), now());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, jsonOrNull(r.value)]));
  }
}

// =====================================================================
// Services : entrées manuelles + corrections/masquages des détectés
// =====================================================================

export interface ServiceOverride {
  serviceId: string;
  patch: Partial<Service>;
  hidden: boolean;
  note: string | null;
  updatedAt: number;
}

export class ServicesRepo {
  constructor(private db: Db) {}

  listManual(): Service[] {
    const rows = this.db.prepare('SELECT * FROM manual_services ORDER BY created_at').all() as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.display_name ?? undefined,
      type: r.type,
      status: r.status,
      version: r.version ?? undefined,
      port: r.port ?? undefined,
      address: r.address ?? undefined,
      process: r.process ?? undefined,
      container: r.container ?? undefined,
      origin: 'manual',
      lastCheck: r.updated_at,
      note: r.note ?? undefined,
    }));
  }

  createManual(input: Omit<Service, 'id' | 'origin' | 'lastCheck'> & { id?: string }): Service {
    const id = input.id ?? newId('msvc');
    const t = now();
    this.db.prepare(
      `INSERT INTO manual_services
       (id, name, display_name, type, status, version, port, address, process, container, note, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.name, input.displayName ?? null, input.type, input.status,
      input.version ?? null, input.port ?? null, input.address ?? null,
      input.process ?? null, input.container ?? null, input.note ?? null, null, t, t,
    );
    return { ...input, id, origin: 'manual', lastCheck: t };
  }

  updateManual(id: string, patch: Partial<Service>): boolean {
    const existing = this.db.prepare('SELECT * FROM manual_services WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!existing) return false;
    const merged = {
      name: patch.name ?? existing.name,
      display_name: patch.displayName !== undefined ? patch.displayName : existing.display_name,
      type: patch.type ?? existing.type,
      status: patch.status ?? existing.status,
      version: patch.version !== undefined ? patch.version : existing.version,
      port: patch.port !== undefined ? patch.port : existing.port,
      address: patch.address !== undefined ? patch.address : existing.address,
      process: patch.process !== undefined ? patch.process : existing.process,
      container: patch.container !== undefined ? patch.container : existing.container,
      note: patch.note !== undefined ? patch.note : existing.note,
    };
    this.db.prepare(
      `UPDATE manual_services SET name=?, display_name=?, type=?, status=?, version=?, port=?,
       address=?, process=?, container=?, note=?, updated_at=? WHERE id=?`,
    ).run(
      merged.name, merged.display_name, merged.type, merged.status, merged.version,
      merged.port, merged.address, merged.process, merged.container, merged.note, now(), id,
    );
    return true;
  }

  deleteManual(id: string): boolean {
    const res = this.db.prepare('DELETE FROM manual_services WHERE id = ?').run(id);
    // Les connexions manuelles rattachées perdent leur sens.
    this.db.prepare('DELETE FROM manual_connections WHERE source_id = ? OR target_id = ?').run(id, id);
    return res.changes > 0;
  }

  listOverrides(): ServiceOverride[] {
    const rows = this.db.prepare('SELECT * FROM service_overrides').all() as Record<string, any>[];
    return rows.map((r) => ({
      serviceId: r.service_id,
      patch: jsonOrNull<Partial<Service>>(r.patch) ?? {},
      hidden: r.hidden === 1,
      note: r.note,
      updatedAt: r.updated_at,
    }));
  }

  setOverride(serviceId: string, patch: Partial<Service>, opts?: { hidden?: boolean; note?: string | null }): void {
    const existing = this.db.prepare('SELECT * FROM service_overrides WHERE service_id = ?').get(serviceId) as Record<string, any> | undefined;
    const mergedPatch = { ...(existing ? jsonOrNull<Partial<Service>>(existing.patch) ?? {} : {}), ...patch };
    const hidden = opts?.hidden !== undefined ? (opts.hidden ? 1 : 0) : (existing?.hidden ?? 0);
    const note = opts?.note !== undefined ? opts.note : (existing?.note ?? null);
    this.db.prepare(
      `INSERT INTO service_overrides (service_id, patch, hidden, note, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET patch=excluded.patch, hidden=excluded.hidden,
       note=excluded.note, updated_at=excluded.updated_at`,
    ).run(serviceId, JSON.stringify(mergedPatch), hidden, note, now());
  }

  setHidden(serviceId: string, hidden: boolean): void {
    this.setOverride(serviceId, {}, { hidden });
  }

  clearOverride(serviceId: string): void {
    this.db.prepare('DELETE FROM service_overrides WHERE service_id = ?').run(serviceId);
  }
}

// =====================================================================
// Connexions : manuelles, corrections, conflits
// =====================================================================

export type DetectedSnapshot = Pick<Connection, 'sourceId' | 'targetId' | 'type' | 'port' | 'endpoint'>;

export interface ConnectionOverride {
  connectionId: string;
  patch: Partial<Connection>;
  detectedOriginal: DetectedSnapshot | null;
  hidden: boolean;
  note: string | null;
  updatedAt: number;
}

export class ConnectionsRepo {
  constructor(private db: Db) {}

  listManual(): Connection[] {
    const rows = this.db.prepare('SELECT * FROM manual_connections ORDER BY created_at').all() as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type,
      protocol: r.protocol ?? undefined,
      port: r.port ?? undefined,
      endpoint: r.endpoint ?? undefined,
      status: r.status,
      origin: 'manual' as const,
      confidence: 1,
      note: r.note ?? undefined,
      lastActivity: r.updated_at,
    }));
  }

  createManual(input: Omit<Connection, 'id' | 'origin'> & { id?: string }): Connection {
    const id = input.id ?? newId('mcx');
    const t = now();
    this.db.prepare(
      `INSERT INTO manual_connections
       (id, source_id, target_id, type, protocol, port, endpoint, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.sourceId, input.targetId, input.type, input.protocol ?? null,
      input.port ?? null, input.endpoint ?? null, input.status ?? 'unknown', input.note ?? null, t, t,
    );
    return { ...input, id, origin: 'manual' };
  }

  updateManual(id: string, patch: Partial<Connection>): boolean {
    const existing = this.db.prepare('SELECT * FROM manual_connections WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!existing) return false;
    this.db.prepare(
      `UPDATE manual_connections SET source_id=?, target_id=?, type=?, protocol=?, port=?,
       endpoint=?, status=?, note=?, updated_at=? WHERE id=?`,
    ).run(
      patch.sourceId ?? existing.source_id,
      patch.targetId ?? existing.target_id,
      patch.type ?? existing.type,
      patch.protocol !== undefined ? patch.protocol : existing.protocol,
      patch.port !== undefined ? patch.port : existing.port,
      patch.endpoint !== undefined ? patch.endpoint : existing.endpoint,
      patch.status ?? existing.status,
      patch.note !== undefined ? patch.note : existing.note,
      now(), id,
    );
    return true;
  }

  deleteManual(id: string): boolean {
    return this.db.prepare('DELETE FROM manual_connections WHERE id = ?').run(id).changes > 0;
  }

  listOverrides(): ConnectionOverride[] {
    const rows = this.db.prepare('SELECT * FROM connection_overrides').all() as Record<string, any>[];
    return rows.map((r) => ({
      connectionId: r.connection_id,
      patch: jsonOrNull<Partial<Connection>>(r.patch) ?? {},
      detectedOriginal: jsonOrNull<DetectedSnapshot>(r.detected_original),
      hidden: r.hidden === 1,
      note: r.note,
      updatedAt: r.updated_at,
    }));
  }

  getOverride(connectionId: string): ConnectionOverride | null {
    return this.listOverrides().find((o) => o.connectionId === connectionId) ?? null;
  }

  /** Enregistre une correction manuelle. La détection d'origine n'est capturée
   *  qu'à la première correction : elle ne doit jamais être écrasée ensuite. */
  setCorrection(connectionId: string, patch: Partial<Connection>, detectedOriginal?: DetectedSnapshot | null): void {
    const existing = this.db.prepare('SELECT * FROM connection_overrides WHERE connection_id = ?').get(connectionId) as Record<string, any> | undefined;
    const mergedPatch = { ...(existing ? jsonOrNull<Partial<Connection>>(existing.patch) ?? {} : {}), ...patch };
    const original = existing?.detected_original ?? (detectedOriginal ? JSON.stringify(detectedOriginal) : null);
    this.db.prepare(
      `INSERT INTO connection_overrides (connection_id, patch, detected_original, hidden, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET patch=excluded.patch,
       detected_original=excluded.detected_original, updated_at=excluded.updated_at`,
    ).run(connectionId, JSON.stringify(mergedPatch), original, existing?.hidden ?? 0, existing?.note ?? null, now());
  }

  setHidden(connectionId: string, hidden: boolean): void {
    const existing = this.db.prepare('SELECT * FROM connection_overrides WHERE connection_id = ?').get(connectionId) as Record<string, any> | undefined;
    this.db.prepare(
      `INSERT INTO connection_overrides (connection_id, patch, detected_original, hidden, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET hidden=excluded.hidden, updated_at=excluded.updated_at`,
    ).run(connectionId, existing?.patch ?? '{}', existing?.detected_original ?? null, hidden ? 1 : 0, existing?.note ?? null, now());
  }

  setNote(connectionId: string, note: string | null): void {
    const existing = this.db.prepare('SELECT * FROM connection_overrides WHERE connection_id = ?').get(connectionId) as Record<string, any> | undefined;
    this.db.prepare(
      `INSERT INTO connection_overrides (connection_id, patch, detected_original, hidden, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at`,
    ).run(connectionId, existing?.patch ?? '{}', existing?.detected_original ?? null, existing?.hidden ?? 0, note, now());
  }

  /** Supprime la correction : la connexion redevient purement détectée. */
  clearCorrection(connectionId: string): void {
    const existing = this.db.prepare('SELECT * FROM connection_overrides WHERE connection_id = ?').get(connectionId) as Record<string, any> | undefined;
    if (!existing) return;
    if (existing.hidden === 1 || existing.note) {
      // On conserve le masquage et la note, on ne retire que la correction.
      this.db.prepare('UPDATE connection_overrides SET patch = ?, detected_original = NULL, updated_at = ? WHERE connection_id = ?')
        .run('{}', now(), connectionId);
    } else {
      this.db.prepare('DELETE FROM connection_overrides WHERE connection_id = ?').run(connectionId);
    }
  }

  listConflicts(): ConnectionConflict[] {
    const rows = this.db.prepare('SELECT * FROM connection_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC').all() as Record<string, any>[];
    return rows.map((r) => ({
      connectionId: r.connection_id,
      detected: jsonOrNull<DetectedSnapshot>(r.detected)!,
      createdAt: r.created_at,
    }));
  }

  hasOpenConflict(connectionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM connection_conflicts WHERE connection_id = ? AND resolved_at IS NULL')
      .get(connectionId) !== undefined;
  }

  recordConflict(connectionId: string, detected: DetectedSnapshot): void {
    this.db.prepare(
      `INSERT INTO connection_conflicts (connection_id, detected, created_at, resolved_at, resolution)
       VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(connection_id) DO UPDATE SET detected=excluded.detected,
       created_at=excluded.created_at, resolved_at=NULL, resolution=NULL`,
    ).run(connectionId, JSON.stringify(detected), now());
  }

  resolveConflict(connectionId: string, acceptDetection: boolean): DetectedSnapshot | null {
    const row = this.db.prepare('SELECT * FROM connection_conflicts WHERE connection_id = ? AND resolved_at IS NULL')
      .get(connectionId) as Record<string, any> | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE connection_conflicts SET resolved_at = ?, resolution = ? WHERE connection_id = ?')
      .run(now(), acceptDetection ? 'accepted-detection' : 'kept-correction', connectionId);
    const detected = jsonOrNull<DetectedSnapshot>(row.detected);
    if (acceptDetection) this.clearCorrection(connectionId);
    return detected;
  }
}

// =====================================================================
// Groupes
// =====================================================================

export class GroupsRepo {
  constructor(private db: Db) {}

  list(): ServiceGroup[] {
    const rows = this.db.prepare('SELECT * FROM service_groups ORDER BY updated_at').all() as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      serviceIds: jsonOrNull<string[]>(r.service_ids) ?? [],
      color: r.color ?? undefined,
      note: r.note ?? undefined,
      collapsed: r.collapsed === 1,
    }));
  }

  upsert(group: ServiceGroup): void {
    this.db.prepare(
      `INSERT INTO service_groups (id, name, service_ids, color, note, collapsed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, service_ids=excluded.service_ids,
       color=excluded.color, note=excluded.note, collapsed=excluded.collapsed, updated_at=excluded.updated_at`,
    ).run(group.id, group.name, JSON.stringify(group.serviceIds), group.color ?? null,
      group.note ?? null, group.collapsed ? 1 : 0, now());
  }

  replaceAll(groups: ServiceGroup[]): void {
    const run = this.db.transaction((list: ServiceGroup[]) => {
      this.db.prepare('DELETE FROM service_groups').run();
      for (const g of list) this.upsert(g);
    });
    run(groups);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM service_groups WHERE id = ?').run(id);
  }
}

// =====================================================================
// Ventilation : configuration des sorties
// =====================================================================

export class FanConfigRepo {
  constructor(private db: Db) {}

  list(): FanConfig[] {
    const rows = this.db.prepare('SELECT * FROM fan_configs').all() as Record<string, any>[];
    const byId = new Map(rows.map((r) => [r.id as FanId, this.rowToConfig(r)]));
    // Ordre stable et complet, même si une ligne manque.
    return defaultFanConfigs().map((d) => byId.get(d.id) ?? d);
  }

  get(id: FanId): FanConfig | null {
    const row = this.db.prepare('SELECT * FROM fan_configs WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return defaultFanConfigs().find((f) => f.id === id) ?? null;
    return this.rowToConfig(row);
  }

  private rowToConfig(r: Record<string, any>): FanConfig {
    return {
      id: r.id,
      displayName: r.display_name,
      assignedHardware: r.assigned_hardware,
      customHardwareLabel: r.custom_hardware_label ?? undefined,
      sensor: jsonOrNull<SensorRef>(r.sensor) ?? { kind: 'single', source: 'cpu' as HardwareId },
      mode: r.mode,
      manualPwm: r.manual_pwm,
      minPwm: r.min_pwm,
      warnRpm: r.warn_rpm,
      curve: jsonOrNull<FanCurve>(r.curve) ?? [],
      monitoringOnly: r.monitoring_only === 1,
    };
  }

  upsert(cfg: FanConfig): void {
    this.db.prepare(
      `INSERT INTO fan_configs (id, display_name, assigned_hardware, custom_hardware_label, sensor,
       mode, manual_pwm, min_pwm, warn_rpm, curve, monitoring_only, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
       assigned_hardware=excluded.assigned_hardware, custom_hardware_label=excluded.custom_hardware_label,
       sensor=excluded.sensor, mode=excluded.mode, manual_pwm=excluded.manual_pwm,
       min_pwm=excluded.min_pwm, warn_rpm=excluded.warn_rpm, curve=excluded.curve,
       monitoring_only=excluded.monitoring_only, updated_at=excluded.updated_at`,
    ).run(
      cfg.id, cfg.displayName, cfg.assignedHardware, cfg.customHardwareLabel ?? null,
      JSON.stringify(cfg.sensor), cfg.mode, cfg.manualPwm, cfg.minPwm, cfg.warnRpm,
      JSON.stringify(cfg.curve), cfg.monitoringOnly ? 1 : 0, now(),
    );
    this.bumpRevision();
  }

  replaceAll(configs: FanConfig[]): void {
    const run = this.db.transaction((list: FanConfig[]) => {
      for (const cfg of list) this.upsert(cfg);
    });
    run(configs);
  }

  /** Compteur incrémenté à chaque modification : le moteur de ventilation
   *  le surveille pour recharger sa configuration sans dépendre de l'API. */
  bumpRevision(): number {
    const settings = new SettingsRepo(this.db);
    const next = settings.get<number>('fanConfigRevision', 0) + 1;
    settings.set('fanConfigRevision', next);
    return next;
  }

  revision(): number {
    return new SettingsRepo(this.db).get<number>('fanConfigRevision', 0);
  }
}

// =====================================================================
// Profils
// =====================================================================

export class ProfilesRepo {
  constructor(private db: Db) {}

  list(): FanProfile[] {
    const rows = this.db.prepare('SELECT * FROM fan_profiles ORDER BY builtin DESC, created_at').all() as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      builtin: r.builtin === 1,
      curves: jsonOrNull<Record<FanId, FanCurve>>(r.curves) ?? ({} as Record<FanId, FanCurve>),
    }));
  }

  get(id: string): FanProfile | null {
    const row = this.db.prepare('SELECT * FROM fan_profiles WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, builtin: row.builtin === 1, curves: jsonOrNull(row.curves) ?? ({} as Record<FanId, FanCurve>) };
  }

  upsert(profile: FanProfile): void {
    const t = now();
    this.db.prepare(
      `INSERT INTO fan_profiles (id, name, builtin, curves, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, curves=excluded.curves, updated_at=excluded.updated_at`,
    ).run(profile.id, profile.name, profile.builtin ? 1 : 0, JSON.stringify(profile.curves), t, t);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM fan_profiles WHERE id = ? AND builtin = 0').run(id).changes > 0;
  }

  /** Réécrit les profils prédéfinis à leur définition d'origine. */
  restoreBuiltins(): void {
    const run = this.db.transaction(() => {
      for (const p of builtinProfiles()) this.upsert(p);
    });
    run();
  }
}

// =====================================================================
// Calibration
// =====================================================================

export class CalibrationRepo {
  constructor(private db: Db) {}

  list(): CalibrationRecord[] {
    const rows = this.db.prepare('SELECT * FROM calibration').all() as Record<string, any>[];
    const byId = new Map(rows.map((r) => [r.fan_id as FanId, rowToCalibration(r)]));
    return defaultFanConfigs().map((f) => byId.get(f.id) ?? emptyCalibration(f.id));
  }

  get(fanId: FanId): CalibrationRecord {
    const row = this.db.prepare('SELECT * FROM calibration WHERE fan_id = ?').get(fanId) as Record<string, any> | undefined;
    return row ? rowToCalibration(row) : emptyCalibration(fanId);
  }

  save(record: CalibrationRecord): void {
    this.db.prepare(
      `INSERT INTO calibration (fan_id, state, output_key, controller_key, controller_driver,
        controller_address, pwm_index, tach_index, last_pwm_path, last_tach_path, assigned_hardware,
        custom_hardware_label, rpm_validation, startup_pwm, minimum_pwm, min_rpm_observed,
        max_rpm_observed, software_control_validated, bios_return, bios_enable_mode,
        manual_enable_mode, bios_version, kernel_version, calibrated_at, notes, invalidated_reason, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(fan_id) DO UPDATE SET
        state=excluded.state, output_key=excluded.output_key, controller_key=excluded.controller_key,
        controller_driver=excluded.controller_driver, controller_address=excluded.controller_address,
        pwm_index=excluded.pwm_index, tach_index=excluded.tach_index,
        last_pwm_path=excluded.last_pwm_path, last_tach_path=excluded.last_tach_path,
        assigned_hardware=excluded.assigned_hardware, custom_hardware_label=excluded.custom_hardware_label,
        rpm_validation=excluded.rpm_validation, startup_pwm=excluded.startup_pwm,
        minimum_pwm=excluded.minimum_pwm, min_rpm_observed=excluded.min_rpm_observed,
        max_rpm_observed=excluded.max_rpm_observed,
        software_control_validated=excluded.software_control_validated,
        bios_return=excluded.bios_return, bios_enable_mode=excluded.bios_enable_mode,
        manual_enable_mode=excluded.manual_enable_mode, bios_version=excluded.bios_version,
        kernel_version=excluded.kernel_version, calibrated_at=excluded.calibrated_at,
        notes=excluded.notes, invalidated_reason=excluded.invalidated_reason, updated_at=excluded.updated_at`,
    ).run(
      record.fanId, record.state, record.outputKey, record.controllerKey, record.controllerDriver,
      record.controllerAddress, record.pwmIndex, record.tachIndex, record.lastPwmPath, record.lastTachPath,
      record.assignedHardware, record.customHardwareLabel, record.rpmValidation, record.startupPwm,
      record.minimumPwm, record.minRpmObserved, record.maxRpmObserved,
      record.softwareControlValidated ? 1 : 0, record.biosReturn, record.biosEnableMode,
      record.manualEnableMode, record.biosVersion, record.kernelVersion, record.calibratedAt,
      record.notes, record.invalidatedReason, now(),
    );
    new FanConfigRepo(this.db).bumpRevision();
  }

  reset(fanId: FanId): void {
    this.db.prepare('DELETE FROM calibration WHERE fan_id = ?').run(fanId);
    new FanConfigRepo(this.db).bumpRevision();
  }
}

export function emptyCalibration(fanId: FanId): CalibrationRecord {
  return {
    fanId, state: 'NOT_CALIBRATED', outputKey: null, controllerKey: null, controllerDriver: null,
    controllerAddress: null, pwmIndex: null, tachIndex: null, lastPwmPath: null, lastTachPath: null,
    assignedHardware: null, customHardwareLabel: null, rpmValidation: null, startupPwm: null,
    minimumPwm: null, minRpmObserved: null, maxRpmObserved: null, softwareControlValidated: false,
    biosReturn: null, biosEnableMode: null, manualEnableMode: null, biosVersion: null,
    kernelVersion: null, calibratedAt: null, notes: null, invalidatedReason: null,
  };
}

function rowToCalibration(r: Record<string, any>): CalibrationRecord {
  return {
    fanId: r.fan_id,
    state: r.state,
    outputKey: r.output_key,
    controllerKey: r.controller_key,
    controllerDriver: r.controller_driver,
    controllerAddress: r.controller_address,
    pwmIndex: r.pwm_index,
    tachIndex: r.tach_index,
    lastPwmPath: r.last_pwm_path,
    lastTachPath: r.last_tach_path,
    assignedHardware: r.assigned_hardware,
    customHardwareLabel: r.custom_hardware_label,
    rpmValidation: r.rpm_validation,
    startupPwm: r.startup_pwm,
    minimumPwm: r.minimum_pwm,
    minRpmObserved: r.min_rpm_observed,
    maxRpmObserved: r.max_rpm_observed,
    softwareControlValidated: r.software_control_validated === 1,
    biosReturn: r.bios_return,
    biosEnableMode: r.bios_enable_mode,
    manualEnableMode: r.manual_enable_mode,
    biosVersion: r.bios_version,
    kernelVersion: r.kernel_version,
    calibratedAt: r.calibrated_at,
    notes: r.notes,
    invalidatedReason: r.invalidated_reason,
  };
}

// =====================================================================
// Alertes
// =====================================================================

export type AlertType =
  | 'HIGH_TEMPERATURE' | 'CRITICAL_TEMPERATURE' | 'FAN_STALLED' | 'FAN_RPM_INCONSISTENT'
  | 'SENSOR_UNAVAILABLE' | 'PWM_WRITE_FAILED' | 'BIOS_RETURN_FAILED' | 'FAN_CONTROLLER_OFFLINE'
  | 'SERVICE_STOPPED' | 'SERVICE_UNREACHABLE' | 'CONNECTION_LOST' | 'CONNECTION_CONFLICT'
  | 'GPU_OFFLINE' | 'STORAGE_HEALTH' | 'DATABASE_ERROR' | 'SAVE_ERROR';

export interface AlertRecord extends Alert {
  type: AlertType;
  updatedAt: number;
  metadata: Record<string, unknown> | null;
}

export interface RaiseAlertInput {
  type: AlertType;
  level: Alert['level'];
  targetKind: Alert['targetKind'];
  targetId: string;
  targetLabel: string;
  message: string;
  value?: string;
  threshold?: string;
  recommendation?: string;
  metadata?: Record<string, unknown>;
}

export class AlertsRepo {
  constructor(private db: Db) {}

  listActive(): AlertRecord[] {
    return (this.db.prepare('SELECT * FROM alerts WHERE active = 1 ORDER BY created_at DESC').all() as Record<string, any>[])
      .map(rowToAlert);
  }

  listRecent(limit = 100): AlertRecord[] {
    return (this.db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, any>[])
      .map(rowToAlert);
  }

  get(id: string): AlertRecord | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Record<string, any> | undefined;
    return row ? rowToAlert(row) : null;
  }

  /** Crée l'alerte si aucune alerte active identique n'existe.
   *  Renvoie `{ alert, created }` — `created` sert à ne journaliser qu'une fois. */
  raise(input: RaiseAlertInput): { alert: AlertRecord; created: boolean } {
    const existing = this.db.prepare(
      'SELECT * FROM alerts WHERE active = 1 AND type = ? AND target_kind = ? AND target_id = ? AND message = ?',
    ).get(input.type, input.targetKind, input.targetId, input.message) as Record<string, any> | undefined;

    if (existing) {
      this.db.prepare('UPDATE alerts SET value = ?, threshold = ?, updated_at = ? WHERE id = ?')
        .run(input.value ?? null, input.threshold ?? null, now(), existing.id);
      return { alert: rowToAlert({ ...existing, value: input.value ?? null, threshold: input.threshold ?? null }), created: false };
    }

    const id = newId('al');
    const t = now();
    this.db.prepare(
      `INSERT INTO alerts (id, type, level, target_kind, target_id, target_label, message, value,
        threshold, recommendation, metadata, created_at, updated_at, active, acknowledged, snoozed_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,NULL)`,
    ).run(
      id, input.type, input.level, input.targetKind, input.targetId, input.targetLabel,
      input.message, input.value ?? null, input.threshold ?? null, input.recommendation ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null, t, t,
    );
    return { alert: this.get(id)!, created: true };
  }

  /** Désactive les alertes d'un type donné sur une cible (la cause a disparu). */
  resolve(targetKind: Alert['targetKind'], targetId: string, type?: AlertType): AlertRecord[] {
    const rows = type
      ? this.db.prepare('SELECT * FROM alerts WHERE active = 1 AND target_kind = ? AND target_id = ? AND type = ?')
        .all(targetKind, targetId, type)
      : this.db.prepare('SELECT * FROM alerts WHERE active = 1 AND target_kind = ? AND target_id = ?')
        .all(targetKind, targetId);
    const list = (rows as Record<string, any>[]).map(rowToAlert);
    for (const a of list) {
      this.db.prepare('UPDATE alerts SET active = 0, updated_at = ? WHERE id = ?').run(now(), a.id);
    }
    return list;
  }

  /** Une alerte acquittée reste active tant que la cause existe. */
  acknowledge(id: string): AlertRecord | null {
    this.db.prepare('UPDATE alerts SET acknowledged = 1, updated_at = ? WHERE id = ?').run(now(), id);
    return this.get(id);
  }

  snooze(id: string, minutes: number): AlertRecord | null {
    this.db.prepare('UPDATE alerts SET snoozed_until = ?, updated_at = ? WHERE id = ?')
      .run(now() + minutes * 60_000, now(), id);
    return this.get(id);
  }

  unsnooze(id: string): AlertRecord | null {
    this.db.prepare('UPDATE alerts SET snoozed_until = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    return this.get(id);
  }

  purgeOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM alerts WHERE active = 0 AND updated_at < ?').run(cutoff).changes;
  }
}

function rowToAlert(r: Record<string, any>): AlertRecord {
  return {
    id: r.id,
    type: r.type,
    level: r.level,
    time: r.created_at,
    updatedAt: r.updated_at,
    targetKind: r.target_kind,
    targetId: r.target_id,
    targetLabel: r.target_label,
    message: r.message,
    value: r.value ?? undefined,
    threshold: r.threshold ?? undefined,
    recommendation: r.recommendation ?? undefined,
    acknowledged: r.acknowledged === 1,
    snoozedUntil: r.snoozed_until ?? undefined,
    active: r.active === 1,
    metadata: jsonOrNull<Record<string, unknown>>(r.metadata),
  };
}

// =====================================================================
// Événements
// =====================================================================

export interface EventInput {
  category: EventCategory;
  level: Severity;
  targetLabel: string;
  message: string;
  metadata?: Record<string, unknown>;
  time?: number;
}

export class EventsRepo {
  constructor(private db: Db) {}

  append(input: EventInput): AppEvent {
    const id = newId('ev');
    const t = input.time ?? now();
    this.db.prepare(
      'INSERT INTO events (id, time, category, level, target_label, message, metadata) VALUES (?,?,?,?,?,?,?)',
    ).run(id, t, input.category, input.level, input.targetLabel, input.message,
      input.metadata ? JSON.stringify(input.metadata) : null);
    return { id, time: t, category: input.category, level: input.level, targetLabel: input.targetLabel, message: input.message };
  }

  list(limit = 200, sinceMs?: number): AppEvent[] {
    const rows = sinceMs
      ? this.db.prepare('SELECT * FROM events WHERE time >= ? ORDER BY time DESC LIMIT ?').all(sinceMs, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY time DESC LIMIT ?').all(limit);
    return (rows as Record<string, any>[]).map((r) => ({
      id: r.id, time: r.time, category: r.category, level: r.level,
      targetLabel: r.target_label, message: r.message,
    }));
  }

  purgeOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM events WHERE time < ?').run(cutoff).changes;
  }
}

// =====================================================================
// Historique
// =====================================================================

export class HistoryRepo {
  constructor(private db: Db) {}

  append(point: HistoryPoint): void {
    this.db.prepare('INSERT OR REPLACE INTO history (t, temps, rpm, pwm) VALUES (?, ?, ?, ?)')
      .run(point.t, JSON.stringify(point.temps), JSON.stringify(point.rpm), JSON.stringify(point.pwm));
  }

  /** Fenêtre glissante. Le front-end demande 60 minutes. */
  range(fromMs: number, toMs = Date.now()): HistoryPoint[] {
    const rows = this.db.prepare('SELECT * FROM history WHERE t >= ? AND t <= ? ORDER BY t').all(fromMs, toMs) as Record<string, any>[];
    return rows.map((r) => ({
      t: r.t,
      temps: jsonOrNull<HistoryPoint['temps']>(r.temps) ?? {},
      rpm: jsonOrNull<HistoryPoint['rpm']>(r.rpm) ?? {},
      pwm: jsonOrNull<HistoryPoint['pwm']>(r.pwm) ?? {},
    }));
  }

  lastPointTime(): number | null {
    const row = this.db.prepare('SELECT MAX(t) AS t FROM history').get() as { t: number | null };
    return row.t ?? null;
  }

  addMarker(marker: Omit<HistoryMarker, never> & { id?: string }): HistoryMarker {
    const id = marker.id ?? newId('mk');
    this.db.prepare('INSERT OR REPLACE INTO history_markers (id, t, label, kind) VALUES (?, ?, ?, ?)')
      .run(id, marker.t, marker.label, marker.kind);
    return { t: marker.t, label: marker.label, kind: marker.kind };
  }

  markers(fromMs: number, toMs = Date.now()): HistoryMarker[] {
    const rows = this.db.prepare('SELECT * FROM history_markers WHERE t >= ? AND t <= ? ORDER BY t').all(fromMs, toMs) as Record<string, any>[];
    return rows.map((r) => ({ t: r.t, label: r.label, kind: r.kind }));
  }

  purgeOlderThan(cutoff: number): number {
    const a = this.db.prepare('DELETE FROM history WHERE t < ?').run(cutoff).changes;
    const b = this.db.prepare('DELETE FROM history_markers WHERE t < ?').run(cutoff).changes;
    return a + b;
  }
}

// =====================================================================
// Regroupement + amorçage
// =====================================================================

export interface Repositories {
  db: Db;
  settings: SettingsRepo;
  services: ServicesRepo;
  connections: ConnectionsRepo;
  groups: GroupsRepo;
  fanConfigs: FanConfigRepo;
  profiles: ProfilesRepo;
  calibration: CalibrationRepo;
  alerts: AlertsRepo;
  events: EventsRepo;
  history: HistoryRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    db,
    settings: new SettingsRepo(db),
    services: new ServicesRepo(db),
    connections: new ConnectionsRepo(db),
    groups: new GroupsRepo(db),
    fanConfigs: new FanConfigRepo(db),
    profiles: new ProfilesRepo(db),
    calibration: new CalibrationRepo(db),
    alerts: new AlertsRepo(db),
    events: new EventsRepo(db),
    history: new HistoryRepo(db),
  };
}

/** Insère les valeurs initiales au premier démarrage. Idempotent.
 *
 *  N'amorce **jamais** de calibration : sur une vraie machine, chaque sortie
 *  reste sous contrôle BIOS tant que l'assistant n'a pas été déroulé. */
export function seedDefaults(repos: Repositories): void {
  if (!repos.settings.has('seeded')) {
    repos.profiles.restoreBuiltins();
    for (const cfg of defaultFanConfigs()) repos.fanConfigs.upsert(cfg);
    repos.settings.set('activeProfileId', DEFAULT_PROFILE_ID);
    repos.settings.set('seeded', true);
    repos.settings.set('installId', randomUUID());
  }
  // Les profils prédéfinis sont réinjectés s'ils ont disparu.
  const profiles = repos.profiles.list();
  for (const builtin of builtinProfiles()) {
    if (!profiles.some((p) => p.id === builtin.id)) repos.profiles.upsert(builtin);
  }
}
