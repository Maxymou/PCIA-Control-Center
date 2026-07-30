/** Routes services et connexions. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../context.js';
import { errorResponse, requireSensitive } from '../security.js';

const serviceTypes = ['ui', 'fan-control', 'docker', 'llm', 'webui', 'api', 'system', 'proxy', 'database', 'other'] as const;
const serviceStatuses = ['running', 'stopped', 'crashed', 'starting', 'restarting', 'unreachable', 'error', 'unknown', 'not-installed'] as const;
const connectionTypes = ['http', 'https', 'openai-api', 'websocket', 'docker', 'cuda', 'hardware', 'sensor', 'pwm', 'database', 'network', 'custom'] as const;
const connectionStatuses = ['active', 'degraded', 'lost', 'unknown', 'new', 'pending'] as const;

const manualServiceSchema = z.object({
  name: z.string().min(1).max(120),
  displayName: z.string().max(120).optional(),
  type: z.enum(serviceTypes),
  status: z.enum(serviceStatuses).default('unknown'),
  version: z.string().max(60).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  address: z.string().max(120).optional(),
  process: z.string().max(120).optional(),
  container: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
});

const servicePatchSchema = manualServiceSchema.partial();

const manualConnectionSchema = z.object({
  sourceId: z.string().min(1).max(120),
  targetId: z.string().min(1).max(120),
  type: z.enum(connectionTypes),
  protocol: z.string().max(60).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  endpoint: z.string().max(300).optional(),
  status: z.enum(connectionStatuses).default('unknown'),
  note: z.string().max(2000).optional(),
});

const connectionPatchSchema = manualConnectionSchema.partial();

export async function registerServiceRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const sensitive = { preHandler: requireSensitive(ctx.config) };

  // =====================================================================
  // Services
  // =====================================================================

  app.get('/api/services', async (request) => {
    const q = request.query as { includeHidden?: string; includeSystem?: string };
    const includeHidden = q.includeHidden === 'true' || q.includeSystem === 'true';
    const merged = ctx.state.fullMerge(includeHidden, false);
    return {
      services: merged.services,
      // Le front-end peut demander explicitement les services masqués.
      hiddenCount: ctx.repos.services.listOverrides().filter((o) => o.hidden).length,
      categories: Object.fromEntries(
        ctx.state.detectedServiceList(true).reduce((acc, s) => {
          acc.set(s.category, (acc.get(s.category) ?? 0) + 1);
          return acc;
        }, new Map<string, number>()),
      ),
    };
  });

  app.get('/api/services/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const merged = ctx.state.fullMerge(true, true);
    const service = merged.services.find((s) => s.id === id);
    if (!service) return errorResponse(reply, 404, 'NOT_FOUND', 'Service inconnu.');
    const detected = ctx.state.detectedServiceList(true).find((s) => s.id === id) ?? null;
    return { service, detected, override: ctx.repos.services.listOverrides().find((o) => o.serviceId === id) ?? null };
  });

  app.post('/api/services/manual', sensitive, async (request, reply) => {
    const parsed = manualServiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Service manuel invalide.', parsed.error.issues);
    }
    const service = ctx.repos.services.createManual(parsed.data);
    ctx.repos.events.append({
      category: 'service', level: 'normal',
      targetLabel: service.displayName ?? service.name, message: 'Service ajouté manuellement',
    });
    ctx.publish('service.updated');
    return reply.code(201).send(service);
  });

  app.put('/api/services/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = servicePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Modification invalide.', parsed.error.issues);
    }
    // Un service manuel est modifié directement ; un service détecté reçoit une correction.
    if (ctx.repos.services.updateManual(id, parsed.data)) {
      ctx.publish('service.updated');
      return { ok: true, kind: 'manual' };
    }
    const known = ctx.state.detectedServiceList(true).some((s) => s.id === id);
    if (!known) return errorResponse(reply, 404, 'NOT_FOUND', 'Service inconnu.');
    ctx.repos.services.setOverride(id, parsed.data, { note: parsed.data.note ?? undefined });
    ctx.publish('service.updated');
    return { ok: true, kind: 'override' };
  });

  app.delete('/api/services/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (ctx.repos.services.deleteManual(id)) {
      ctx.repos.events.append({
        category: 'service', level: 'normal', targetLabel: id, message: 'Service manuel supprimé',
      });
      ctx.publish('service.updated');
      return { ok: true };
    }
    // Un service détecté ne se supprime pas : il se masque.
    return errorResponse(reply, 409, 'NOT_DELETABLE',
      'Un service détecté ne peut pas être supprimé. Utiliser /hide pour le masquer.');
  });

  app.post('/api/services/:id/hide', sensitive, async (request) => {
    const { id } = request.params as { id: string };
    ctx.repos.services.setHidden(id, true);
    ctx.publish('service.updated');
    return { ok: true };
  });

  app.post('/api/services/:id/show', sensitive, async (request) => {
    const { id } = request.params as { id: string };
    ctx.repos.services.setHidden(id, false);
    ctx.publish('service.updated');
    return { ok: true };
  });

  // =====================================================================
  // Connexions
  // =====================================================================

  app.get('/api/connections', async (request) => {
    const q = request.query as { includeHidden?: string; includeLowConfidence?: string };
    const merged = ctx.state.fullMerge(q.includeHidden === 'true', q.includeLowConfidence === 'true');
    return {
      connections: merged.connections,
      conflicts: merged.conflicts,
    };
  });

  app.get('/api/connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const merged = ctx.state.fullMerge(true, true);
    const connection = merged.connections.find((c) => c.id === id);
    if (!connection) return errorResponse(reply, 404, 'NOT_FOUND', 'Connexion inconnue.');
    const detected = ctx.state.discoveryTracker().detectedById(id);
    return {
      connection,
      detected,
      override: ctx.repos.connections.getOverride(id),
      conflict: merged.conflicts.find((c) => c.connectionId === id) ?? null,
    };
  });

  app.post('/api/connections/manual', sensitive, async (request, reply) => {
    const parsed = manualConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Connexion manuelle invalide.', parsed.error.issues);
    }
    const snapshot = ctx.state.fullMerge(true, true);
    const known = new Set(snapshot.services.map((s) => s.id));
    if (!known.has(parsed.data.sourceId) || !known.has(parsed.data.targetId)) {
      return errorResponse(reply, 400, 'UNKNOWN_ENDPOINT', 'Source ou destination inconnue.');
    }
    const connection = ctx.repos.connections.createManual(parsed.data);
    ctx.repos.events.append({
      category: 'connection', level: 'normal',
      targetLabel: `${connection.sourceId} → ${connection.targetId}`, message: 'Connexion ajoutée manuellement',
    });
    ctx.publish('connection.updated');
    return reply.code(201).send(connection);
  });

  app.put('/api/connections/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = connectionPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Modification invalide.', parsed.error.issues);
    }
    if (ctx.repos.connections.updateManual(id, parsed.data)) {
      ctx.publish('connection.updated');
      return { ok: true, kind: 'manual' };
    }
    const detected = ctx.state.discoveryTracker().detectedById(id);
    if (!detected) return errorResponse(reply, 404, 'NOT_FOUND', 'Connexion inconnue.');
    // Correction d'une connexion détectée : la détection d'origine est conservée.
    ctx.repos.connections.setCorrection(id, parsed.data, {
      sourceId: detected.sourceId, targetId: detected.targetId,
      type: detected.type, port: detected.port, endpoint: detected.endpoint,
    });
    ctx.repos.events.append({
      category: 'connection', level: 'normal', targetLabel: id, message: 'Connexion corrigée manuellement',
    });
    ctx.publish('connection.updated');
    return { ok: true, kind: 'correction' };
  });

  app.delete('/api/connections/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (ctx.repos.connections.deleteManual(id)) {
      ctx.publish('connection.updated');
      return { ok: true };
    }
    return errorResponse(reply, 409, 'NOT_DELETABLE',
      'Une connexion détectée ne peut pas être supprimée. Utiliser /hide pour la masquer.');
  });

  app.post('/api/connections/:id/hide', sensitive, async (request) => {
    const { id } = request.params as { id: string };
    ctx.repos.connections.setHidden(id, true);
    ctx.publish('connection.updated');
    return { ok: true };
  });

  app.post('/api/connections/:id/show', sensitive, async (request) => {
    const { id } = request.params as { id: string };
    ctx.repos.connections.setHidden(id, false);
    ctx.publish('connection.updated');
    return { ok: true };
  });

  /** Abandonne la correction : la connexion revient à sa version détectée. */
  app.post('/api/connections/:id/restore-detected', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.repos.connections.getOverride(id)) {
      return errorResponse(reply, 404, 'NO_CORRECTION', 'Aucune correction enregistrée pour cette connexion.');
    }
    ctx.repos.connections.clearCorrection(id);
    ctx.repos.events.append({
      category: 'connection', level: 'normal', targetLabel: id, message: 'Version détectée restaurée',
    });
    ctx.publish('connection.updated');
    return { ok: true };
  });

  /** Arbitrage d'un conflit détection ↔ correction. */
  app.post('/api/connections/:id/resolve-conflict', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ acceptDetection: z.boolean() }).safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Choix de résolution manquant.', body.error.issues);
    }
    const resolved = ctx.repos.connections.resolveConflict(id, body.data.acceptDetection);
    if (resolved === null) return errorResponse(reply, 404, 'NO_CONFLICT', 'Aucun conflit ouvert sur cette connexion.');
    ctx.repos.events.append({
      category: 'connection', level: 'normal', targetLabel: id,
      message: body.data.acceptDetection ? 'Nouvelle détection acceptée' : 'Correction utilisateur conservée',
    });
    ctx.publish('connection.updated');
    return { ok: true };
  });

  /** Note libre attachée à une connexion (persistée). */
  app.put('/api/connections/:id/note', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ note: z.string().max(2000).nullable() }).safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Note invalide.', body.error.issues);
    }
    ctx.repos.connections.setNote(id, body.data.note);
    ctx.publish('connection.updated');
    return { ok: true };
  });
}
