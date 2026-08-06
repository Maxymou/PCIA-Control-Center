/** Routes de l'assistant de calibration.
 *
 *  Les étapes longues s'exécutent côté moteur et rendent la main immédiatement :
 *  l'avancement est diffusé par WebSocket (`calibration.updated`) et lisible via
 *  `GET /api/calibration`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FAN_IDS } from '../../contract.js';
import { FanEngineUnavailable } from '../../app/fanGateway.js';
import type { ApiContext } from '../context.js';
import { errorResponse, requireSensitive } from '../security.js';

const fanIdSchema = z.enum(FAN_IDS);

const startSchema = z.object({ outputKey: z.string().min(1).max(200) });

const confirmSchema = z.object({
  assignedHardware: z.enum(['cpu', 'nvme', 'v100-1', 'v100-2', 'gtx1080', 'case-front', 'case-rear', 'motherboard', 'none', 'custom']),
  customLabel: z.string().max(80).optional(),
  tachKey: z.string().max(200).nullable().optional(),
  inconclusive: z.boolean().optional(),
});

export async function registerCalibrationRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const sensitive = { preHandler: requireSensitive(ctx.config) };

  const engineError = (reply: Parameters<typeof errorResponse>[0], err: unknown) => {
    if (err instanceof FanEngineUnavailable) {
      return errorResponse(reply, 503, 'FAN_ENGINE_UNAVAILABLE',
        'Moteur de ventilation injoignable : calibration impossible.');
    }
    return errorResponse(reply, 500, 'CALIBRATION_ERROR', (err as Error).message);
  };

  const fanId = (request: { params: unknown }) => fanIdSchema.safeParse((request.params as { fanId: string }).fanId);

  app.get('/api/calibration', async () => {
    let sessions: unknown = [];
    try {
      sessions = await ctx.fans.send('calibration.sessions');
    } catch {
      // Moteur hors ligne : les enregistrements persistés restent consultables.
    }
    return {
      records: ctx.repos.calibration.list(),
      sessions,
      engineOnline: ctx.fans.online(),
      requireBiosReturnValidation: ctx.config.fanControl.requireBiosReturnValidation,
      // Nécessaire pour que l'assistant sache si une sortie est en supervision
      // seule (`monitoringOnly`) — caractéristique de fan_configs, pas de l'état
      // de calibration.
      fanConfigs: ctx.repos.fanConfigs.list(),
    };
  });

  /** Inventaire des sorties disponibles, sans aucune prise de contrôle. */
  app.post('/api/calibration/discover', sensitive, async (_request, reply) => {
    try {
      const discovery = await ctx.fans.send('calibration.discover');
      ctx.emit('calibration.updated', { discovery });
      return discovery;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  app.post('/api/calibration/:fanId/start', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = startSchema.safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Sortie PWM à calibrer non précisée.', body.error.issues);
    }
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('calibration.start', {
        fanId: id.data, outputKey: body.data.outputKey,
      });
      if (!result.ok) return errorResponse(reply, 409, 'CALIBRATION_REFUSED', result.error ?? 'Démarrage refusé.');
      ctx.repos.events.append({
        category: 'fan', level: 'normal', targetLabel: id.data, message: 'Calibration démarrée',
      });
      ctx.emit('calibration.updated', result);
      return result;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  const step = (route: string, command: string, eventMessage: string) => {
    app.post(`/api/calibration/:fanId/${route}`, sensitive, async (request, reply) => {
      const id = fanId(request);
      if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
      try {
        const result = await ctx.fans.send<{ ok: boolean; error?: string }>(command as never, { fanId: id.data });
        if (!result.ok) return errorResponse(reply, 409, 'STEP_REFUSED', result.error ?? 'Étape refusée.');
        ctx.repos.events.append({
          category: 'fan', level: 'normal', targetLabel: id.data, message: eventMessage,
        });
        ctx.emit('calibration.updated', { fanId: id.data, step: route });
        return reply.code(202).send({ ok: true, running: true });
      } catch (err) {
        return engineError(reply, err);
      }
    });
  };

  step('identify', 'calibration.identify', 'Calibration : identification physique lancée');
  step('test-rpm', 'calibration.testRpm', 'Calibration : validation du retour RPM lancée');
  step('detect-minimum', 'calibration.detectMinimum', 'Calibration : détection du minimum lancée');
  step('test-software-control', 'calibration.testSoftwareControl', 'Calibration : validation du contrôle logiciel lancée');
  step('test-bios-return', 'calibration.testBiosReturn', 'Calibration : test de retour BIOS lancé');

  app.post('/api/calibration/:fanId/confirm-identification', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = confirmSchema.safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Confirmation invalide.', body.error.issues);
    }
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('calibration.confirmIdentification', {
        fanId: id.data, ...body.data,
      });
      if (!result.ok) return errorResponse(reply, 409, 'CONFIRM_REFUSED', result.error ?? 'Confirmation refusée.');
      ctx.emit('calibration.updated', { fanId: id.data });
      return result;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  app.post('/api/calibration/:fanId/authorize', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = z.object({ acceptRestricted: z.boolean().optional() }).safeParse(request.body ?? {});
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('calibration.authorize', {
        fanId: id.data,
        acceptRestricted: body.success ? body.data.acceptRestricted : false,
      });
      if (!result.ok) return errorResponse(reply, 409, 'AUTHORIZATION_REFUSED', result.error ?? 'Autorisation refusée.');
      ctx.repos.events.append({
        category: 'fan', level: 'normal', targetLabel: id.data,
        message: 'Calibration terminée — sortie autorisée',
      });
      ctx.publish('calibration.updated');
      return result;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  app.post('/api/calibration/:fanId/cancel', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      const result = await ctx.fans.send('calibration.cancel', { fanId: id.data });
      ctx.repos.events.append({
        category: 'fan', level: 'normal', targetLabel: id.data,
        message: 'Calibration annulée — état initial restauré',
      });
      ctx.publish('calibration.updated');
      return result;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  /** Arrêt d'urgence — priorité absolue, aucune validation superflue. */
  app.post('/api/calibration/:fanId/emergency-stop', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      const result = await ctx.fans.send('calibration.emergencyStop', { fanId: id.data });
      ctx.repos.events.append({
        category: 'fan', level: 'warning', targetLabel: id.data,
        message: 'Arrêt d’urgence de la calibration',
      });
      ctx.publish('calibration.updated');
      return result;
    } catch (err) {
      return engineError(reply, err);
    }
  });

  app.post('/api/calibration/:fanId/reset', sensitive, async (request, reply) => {
    const id = fanId(request);
    if (!id.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('calibration.reset', { fanId: id.data });
      if (!result.ok) {
        // Ne jamais annoncer un retour BIOS qui n'a pas été vérifié.
        return errorResponse(reply, 409, 'RESET_REFUSED', result.error ?? 'Réinitialisation refusée.');
      }
      ctx.repos.events.append({
        category: 'fan', level: 'warning', targetLabel: id.data,
        message: 'Calibration réinitialisée — retour au contrôle BIOS confirmé',
      });
      ctx.publish('calibration.updated');
      return { ok: true };
    } catch (err) {
      return engineError(reply, err);
    }
  });
}
