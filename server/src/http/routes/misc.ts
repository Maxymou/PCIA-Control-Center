/** Routes alertes, événements, configuration et mode démonstration. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../context.js';
import { errorResponse, requireSensitive } from '../security.js';
import { DEMO_SCENARIOS } from '../../demo/world.js';
import { defaultFanConfigs, builtinProfiles, DEFAULT_PROFILE_ID } from '../../fan/defaults.js';
import { validateCurve } from '../../fan/curve.js';
import { APP_VERSION } from '../../app/state.js';
import type { EventCategory, FanConfig, ServiceGroup, Severity } from '../../contract.js';

const eventSchema = z.object({
  category: z.enum(['temperature', 'fan', 'service', 'connection', 'hardware', 'profile', 'curve', 'alert', 'config']),
  level: z.enum(['normal', 'warning', 'critical', 'unknown']),
  targetLabel: z.string().min(1).max(200),
  message: z.string().min(1).max(500),
});

const markerSchema = z.object({
  label: z.string().min(1).max(200),
  kind: z.enum(['alert', 'event', 'profile']).default('profile'),
});

const groupSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(120),
  serviceIds: z.array(z.string().min(1).max(120)).max(200),
  color: z.string().max(30).optional(),
  note: z.string().max(2000).optional(),
  collapsed: z.boolean().optional(),
});

export async function registerMiscRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const sensitive = { preHandler: requireSensitive(ctx.config) };

  // =====================================================================
  // Alertes
  // =====================================================================

  app.get('/api/alerts', async (request) => {
    const q = request.query as { all?: string; limit?: string };
    const limit = Math.max(1, Math.min(500, Number(q.limit ?? 120) || 120));
    return {
      alerts: q.all === 'true' ? ctx.repos.alerts.listRecent(limit) : ctx.repos.alerts.listActive(),
      activeCount: ctx.repos.alerts.listActive().length,
    };
  });

  app.post('/api/alerts/:id/acknowledge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const alert = ctx.repos.alerts.acknowledge(id);
    if (!alert) return errorResponse(reply, 404, 'NOT_FOUND', 'Alerte inconnue.');
    ctx.repos.events.append({
      category: 'alert', level: 'normal', targetLabel: alert.targetLabel, message: 'Alerte acquittée',
    });
    ctx.publish('alert.updated');
    return alert;
  });

  app.post('/api/alerts/:id/snooze', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ minutes: z.number().int().min(1).max(24 * 60).default(15) }).safeParse(request.body ?? {});
    const minutes = body.success ? body.data.minutes : 15;
    const alert = ctx.repos.alerts.snooze(id, minutes);
    if (!alert) return errorResponse(reply, 404, 'NOT_FOUND', 'Alerte inconnue.');
    ctx.publish('alert.updated');
    return alert;
  });

  app.post('/api/alerts/:id/unsnooze', async (request, reply) => {
    const { id } = request.params as { id: string };
    const alert = ctx.repos.alerts.unsnooze(id);
    if (!alert) return errorResponse(reply, 404, 'NOT_FOUND', 'Alerte inconnue.');
    ctx.publish('alert.updated');
    return alert;
  });

  // =====================================================================
  // Événements
  // =====================================================================

  app.get('/api/events', async (request) => {
    const q = request.query as { limit?: string; sinceMinutes?: string };
    const limit = Math.max(1, Math.min(1000, Number(q.limit ?? 200) || 200));
    const since = q.sinceMinutes ? Date.now() - Number(q.sinceMinutes) * 60_000 : undefined;
    return { events: ctx.repos.events.list(limit, since) };
  });

  /** Journalisation d'une action réalisée dans l'interface. */
  app.post('/api/events', async (request, reply) => {
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Événement invalide.', parsed.error.issues);
    }
    const event = ctx.repos.events.append({
      category: parsed.data.category as EventCategory,
      level: parsed.data.level as Severity,
      targetLabel: parsed.data.targetLabel,
      message: parsed.data.message,
    });
    ctx.emit('event.created', event);
    return reply.code(201).send(event);
  });

  app.post('/api/history/markers', async (request, reply) => {
    const parsed = markerSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Repère invalide.', parsed.error.issues);
    }
    const marker = ctx.repos.history.addMarker({ t: Date.now(), label: parsed.data.label, kind: parsed.data.kind });
    return reply.code(201).send(marker);
  });

  // =====================================================================
  // Groupes de services
  // =====================================================================

  app.get('/api/groups', async () => ({ groups: ctx.repos.groups.list() }));

  app.put('/api/groups', sensitive, async (request, reply) => {
    const parsed = z.array(groupSchema).max(100).safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Groupes invalides.', parsed.error.issues);
    }
    const groups: ServiceGroup[] = parsed.data.map((g, i) => ({
      id: g.id ?? `grp-${i}-${Date.now().toString(36)}`,
      name: g.name,
      serviceIds: g.serviceIds,
      color: g.color,
      note: g.note,
      collapsed: g.collapsed ?? false,
    }));
    ctx.repos.groups.replaceAll(groups);
    return { ok: true, groups };
  });

  // =====================================================================
  // Configuration
  // =====================================================================

  /** Préférences d'interface persistées côté serveur (disposition, filtres…). */
  app.get('/api/config/ui', async () => ({
    version: 1,
    data: ctx.repos.settings.get<Record<string, unknown> | null>('uiState', null),
  }));

  app.put('/api/config/ui', async (request, reply) => {
    const parsed = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'État d’interface invalide.', parsed.error.issues);
    }
    const serialized = JSON.stringify(parsed.data.data);
    // Garde-fou : une disposition de graphe raisonnable reste bien en deçà.
    if (serialized.length > 2_000_000) {
      return errorResponse(reply, 413, 'PAYLOAD_TOO_LARGE', 'État d’interface trop volumineux.');
    }
    try {
      ctx.repos.settings.set('uiState', parsed.data.data);
      return { ok: true };
    } catch (err) {
      ctx.repos.alerts.raise({
        type: 'SAVE_ERROR', level: 'warning', targetKind: 'hardware', targetId: 'database',
        targetLabel: 'Base de données', message: 'Enregistrement des préférences impossible',
        recommendation: 'Vérifier l’espace disque et les permissions.',
      });
      return errorResponse(reply, 500, 'SAVE_ERROR', (err as Error).message);
    }
  });

  app.get('/api/config', async () => ({
    server: { host: ctx.config.server.host, port: ctx.config.server.port },
    mode: ctx.env.mode,
    history: ctx.config.history,
    fanControl: ctx.config.fanControl,
    calibration: ctx.config.calibration,
    alerts: ctx.config.alerts,
    security: {
      lanOnly: ctx.config.security.lanOnly,
      authMode: ctx.config.security.authMode,
      allowSensitiveActions: ctx.config.security.allowSensitiveActions,
    },
  }));

  /** Export complet — sans aucun secret, réimportable tel quel. */
  app.get('/api/config/export', async () => buildExport(ctx));

  app.post('/api/config/import', sensitive, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Export invalide.', parsed.error.issues);
    }
    const payload = parsed.data;
    const errors: string[] = [];

    // Validation complète AVANT toute écriture : import tout-ou-rien.
    const fanConfigs: FanConfig[] = [];
    for (const cfg of payload.fanConfigs ?? []) {
      const validation = validateCurve(cfg.curve);
      if (!validation.ok) {
        errors.push(`Courbe de ${cfg.id} : ${validation.errors.join(' ')}`);
        continue;
      }
      fanConfigs.push({ ...cfg, curve: validation.curve! } as FanConfig);
    }
    for (const profile of payload.profiles ?? []) {
      for (const [fanId, curve] of Object.entries(profile.curves)) {
        const validation = validateCurve(curve);
        if (!validation.ok) errors.push(`Profil ${profile.name} / ${fanId} : ${validation.errors.join(' ')}`);
      }
    }
    if (errors.length) {
      return errorResponse(reply, 400, 'INVALID_IMPORT', 'Import refusé : données invalides.', errors);
    }

    const run = ctx.repos.db.transaction(() => {
      if (fanConfigs.length) ctx.repos.fanConfigs.replaceAll(fanConfigs);
      for (const p of payload.profiles ?? []) {
        if (p.builtin) continue; // les prédéfinis restent gérés par le back-end
        ctx.repos.profiles.upsert(p as never);
      }
      if (payload.groups) ctx.repos.groups.replaceAll(payload.groups as ServiceGroup[]);
      for (const s of payload.manualServices ?? []) ctx.repos.services.createManual(s as never);
      for (const c of payload.manualConnections ?? []) ctx.repos.connections.createManual(c as never);
      for (const o of payload.serviceOverrides ?? []) {
        ctx.repos.services.setOverride(o.serviceId, o.patch as never, { hidden: o.hidden, note: o.note ?? null });
      }
      for (const o of payload.connectionOverrides ?? []) {
        ctx.repos.connections.setCorrection(o.connectionId, o.patch as never, o.detectedOriginal as never);
        if (o.hidden) ctx.repos.connections.setHidden(o.connectionId, true);
        if (o.note) ctx.repos.connections.setNote(o.connectionId, o.note);
      }
      if (payload.uiState) ctx.repos.settings.set('uiState', payload.uiState);
      if (payload.activeProfileId) ctx.repos.settings.set('activeProfileId', payload.activeProfileId);
      if (payload.sensorOverrides) ctx.repos.settings.set('sensorOverrides', payload.sensorOverrides);
    });

    try {
      run();
    } catch (err) {
      return errorResponse(reply, 500, 'IMPORT_FAILED', (err as Error).message);
    }

    ctx.repos.events.append({
      category: 'config', level: 'warning', targetLabel: 'Configuration',
      message: 'Configuration importée',
    });
    ctx.publish();
    return { ok: true };
  });

  /** Réinitialisation. La calibration n'est effacée que sur demande explicite. */
  app.post('/api/config/reset', sensitive, async (request) => {
    const body = z.object({
      includeCalibration: z.boolean().default(false),
      includeHistory: z.boolean().default(false),
    }).safeParse(request.body ?? {});
    const opts = body.success ? body.data : { includeCalibration: false, includeHistory: false };

    const run = ctx.repos.db.transaction(() => {
      ctx.repos.db.prepare('DELETE FROM manual_services').run();
      ctx.repos.db.prepare('DELETE FROM manual_connections').run();
      ctx.repos.db.prepare('DELETE FROM service_overrides').run();
      ctx.repos.db.prepare('DELETE FROM connection_overrides').run();
      ctx.repos.db.prepare('DELETE FROM connection_conflicts').run();
      ctx.repos.db.prepare('DELETE FROM service_groups').run();
      ctx.repos.db.prepare('DELETE FROM fan_profiles WHERE builtin = 0').run();
      ctx.repos.profiles.restoreBuiltins();
      ctx.repos.fanConfigs.replaceAll(defaultFanConfigs());
      ctx.repos.settings.set('activeProfileId', DEFAULT_PROFILE_ID);
      ctx.repos.settings.delete('uiState');
      if (opts.includeHistory) {
        ctx.repos.db.prepare('DELETE FROM history').run();
        ctx.repos.db.prepare('DELETE FROM history_markers').run();
      }
      if (opts.includeCalibration) {
        // Les sorties repassent sous contrôle BIOS au prochain cycle du moteur.
        ctx.repos.db.prepare('DELETE FROM calibration').run();
        ctx.repos.fanConfigs.bumpRevision();
      }
    });
    run();

    ctx.repos.events.append({
      category: 'config', level: 'warning', targetLabel: 'Configuration',
      message: opts.includeCalibration
        ? 'Configuration réinitialisée (calibration comprise)'
        : 'Configuration réinitialisée',
    });
    try {
      await ctx.fans.send('reload');
    } catch {
      /* moteur hors ligne : il rechargera au démarrage */
    }
    ctx.publish();
    return { ok: true };
  });

  // =====================================================================
  // Mode démonstration
  // =====================================================================

  app.get('/api/demo', async () => ({
    enabled: ctx.env.demo !== null,
    scenarios: DEMO_SCENARIOS,
    state: ctx.env.demo?.state() ?? null,
  }));

  app.post('/api/demo/:scenario', async (request, reply) => {
    if (!ctx.env.demo) {
      // En mode matériel, aucun scénario simulé n'est jouable : c'est volontaire.
      return errorResponse(reply, 409, 'DEMO_DISABLED',
        'Les scénarios de démonstration ne sont disponibles qu’en mode démo (PCIA_MODE=demo).');
    }
    const { scenario } = request.params as { scenario: string };
    if (!(DEMO_SCENARIOS as readonly string[]).includes(scenario)) {
      return errorResponse(reply, 404, 'UNKNOWN_SCENARIO', `Scénario inconnu : ${scenario}`);
    }
    const result = ctx.env.demo.trigger(scenario);
    ctx.repos.events.append({
      category: 'config', level: 'normal', targetLabel: 'Démonstration', message: result.message,
    });
    if (scenario === 'reset') {
      ctx.repos.db.prepare('DELETE FROM connection_conflicts').run();
      ctx.repos.db.prepare('DELETE FROM connection_overrides').run();
    }
    ctx.publish();
    return result;
  });
}

const importSchema = z.object({
  version: z.number().optional(),
  application: z.string().optional(),
  fanConfigs: z.array(z.any()).optional(),
  profiles: z.array(z.object({
    id: z.string(), name: z.string(), builtin: z.boolean(),
    curves: z.record(z.string(), z.array(z.object({ temp: z.number(), pwm: z.number() }))),
  })).optional(),
  groups: z.array(z.any()).optional(),
  manualServices: z.array(z.any()).optional(),
  manualConnections: z.array(z.any()).optional(),
  serviceOverrides: z.array(z.object({
    serviceId: z.string(), patch: z.record(z.string(), z.unknown()),
    hidden: z.boolean(), note: z.string().nullable().optional(),
  })).optional(),
  connectionOverrides: z.array(z.object({
    connectionId: z.string(), patch: z.record(z.string(), z.unknown()),
    detectedOriginal: z.any().nullable().optional(),
    hidden: z.boolean(), note: z.string().nullable().optional(),
  })).optional(),
  uiState: z.record(z.string(), z.unknown()).nullable().optional(),
  activeProfileId: z.string().optional(),
  sensorOverrides: z.record(z.string(), z.string()).optional(),
});

export function buildExport(ctx: ApiContext): Record<string, unknown> {
  return {
    version: 1,
    application: 'pcia-control-center',
    applicationVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    fanConfigs: ctx.repos.fanConfigs.list(),
    profiles: ctx.repos.profiles.list(),
    activeProfileId: ctx.repos.settings.get<string>('activeProfileId', DEFAULT_PROFILE_ID),
    groups: ctx.repos.groups.list(),
    manualServices: ctx.repos.services.listManual(),
    manualConnections: ctx.repos.connections.listManual(),
    serviceOverrides: ctx.repos.services.listOverrides(),
    connectionOverrides: ctx.repos.connections.listOverrides(),
    sensorOverrides: ctx.repos.settings.get('sensorOverrides', {}),
    gpuSlots: ctx.repos.settings.get('gpuSlots', {}),
    calibration: ctx.repos.calibration.list(),
    uiState: ctx.repos.settings.get<Record<string, unknown> | null>('uiState', null),
    builtinProfileIds: builtinProfiles().map((p) => p.id),
    // Aucun jeton, mot de passe ou numéro de série n'est exporté.
  };
}
