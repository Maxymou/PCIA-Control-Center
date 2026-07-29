/** Routes ventilation : sorties, courbes, modes, profils.
 *
 *  Toute courbe est validée côté serveur avant d'être enregistrée, puis
 *  appliquée. En cas d'échec d'application, la version précédente est restaurée
 *  (mécanisme transactionnel exigé au §14).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FanConfig, FanCurve, FanId, FanProfile } from '../../contract.js';
import { FAN_IDS } from '../../contract.js';
import { validateCurve } from '../../fan/curve.js';
import { BUILTIN_PROFILE_IDS, builtinProfiles, effectiveMinPwm } from '../../fan/defaults.js';
import { newId } from '../../db/repositories.js';
import { FanEngineUnavailable } from '../../app/fanGateway.js';
import type { ApiContext } from '../context.js';
import { errorResponse, requireSensitive } from '../security.js';

const fanIdSchema = z.enum(FAN_IDS);

const sensorRefSchema = z.union([
  z.object({ kind: z.literal('single'), source: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('hottest-gpu') }),
  z.object({ kind: z.literal('max'), sources: z.array(z.string().min(1).max(40)).min(1).max(8) }),
  z.object({ kind: z.literal('avg'), sources: z.array(z.string().min(1).max(40)).min(1).max(8) }),
]);

const fanConfigPatchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  assignedHardware: z.string().min(1).max(40).optional(),
  customHardwareLabel: z.string().max(80).nullable().optional(),
  sensor: sensorRefSchema.optional(),
  manualPwm: z.number().int().min(0).max(100).optional(),
  minPwm: z.number().int().min(0).max(80).optional(),
  warnRpm: z.number().int().min(0).max(10_000).optional(),
});

const curveBodySchema = z.object({
  curve: z.array(z.object({ temp: z.number(), pwm: z.number() })),
});

const modeSchema = z.object({
  mode: z.enum(['auto', 'manual', 'full', 'test']),
  manualPwm: z.number().int().min(0).max(100).optional(),
});

const profileBodySchema = z.object({
  name: z.string().min(1).max(80),
  curves: z.record(z.string(), z.array(z.object({ temp: z.number(), pwm: z.number() }))).optional(),
});

/** Valide toutes les courbes d'un profil d'un coup. */
function validateProfileCurves(raw: Record<string, unknown>): { ok: true; curves: Record<FanId, FanCurve> } | { ok: false; errors: string[] } {
  const curves = {} as Record<FanId, FanCurve>;
  const errors: string[] = [];
  for (const id of FAN_IDS) {
    const validation = validateCurve(raw[id]);
    if (!validation.ok) errors.push(`${id} : ${validation.errors.join(' ')}`);
    else curves[id] = validation.curve!;
  }
  return errors.length ? { ok: false, errors } : { ok: true, curves };
}

export async function registerFanRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const sensitive = { preHandler: requireSensitive(ctx.config) };

  const respondEngineError = (reply: Parameters<typeof errorResponse>[0], err: unknown) => {
    if (err instanceof FanEngineUnavailable) {
      return errorResponse(reply, 503, 'FAN_ENGINE_UNAVAILABLE',
        'Moteur de ventilation injoignable. La régulation continue de son côté ; vérifier `systemctl status pcia-fan-control`.');
    }
    return errorResponse(reply, 500, 'FAN_ENGINE_ERROR', (err as Error).message);
  };

  // =====================================================================
  // Lecture
  // =====================================================================

  app.get('/api/fans', async () => {
    const snapshot = ctx.state.snapshot();
    return {
      configs: ctx.repos.fanConfigs.list(),
      live: snapshot.fans,
      outputs: snapshot.fanOutputs,
      calibration: ctx.repos.calibration.list(),
      engineOnline: ctx.fans.online(),
      activeProfileId: ctx.repos.settings.get<string>('activeProfileId', 'p-balanced'),
    };
  });

  app.get('/api/fans/:id', async (request, reply) => {
    const parsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!parsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const id = parsed.data;
    const snapshot = ctx.state.snapshot();
    return {
      config: ctx.repos.fanConfigs.get(id),
      live: snapshot.fans.find((f) => f.id === id) ?? null,
      output: snapshot.fanOutputs.find((o) => o.id === id) ?? null,
      calibration: ctx.repos.calibration.get(id),
    };
  });

  // =====================================================================
  // Configuration d'une sortie
  // =====================================================================

  app.put('/api/fans/:id/configuration', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const parsed = fanConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Configuration invalide.', parsed.error.issues);
    }
    const id = idParsed.data;
    const current = ctx.repos.fanConfigs.get(id)!;
    const next: FanConfig = {
      ...current,
      ...parsed.data,
      assignedHardware: (parsed.data.assignedHardware ?? current.assignedHardware) as FanConfig['assignedHardware'],
      customHardwareLabel: parsed.data.customHardwareLabel === null
        ? undefined
        : parsed.data.customHardwareLabel ?? current.customHardwareLabel,
      sensor: (parsed.data.sensor ?? current.sensor) as FanConfig['sensor'],
      // Le plancher de sécurité des sorties passives ne peut pas être contourné.
      minPwm: effectiveMinPwm(id, parsed.data.minPwm ?? current.minPwm),
    };
    ctx.repos.fanConfigs.upsert(next);
    ctx.repos.events.append({
      category: 'fan', level: 'normal', targetLabel: next.displayName,
      message: 'Réglages de la sortie modifiés',
    });
    ctx.publish('fan.updated');
    return { ok: true, config: next };
  });

  /** Application immédiate après validation, avec retour arrière en cas d'échec. */
  app.put('/api/fans/:id/curve', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = curveBodySchema.safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Corps de requête invalide.', body.error.issues);
    }
    const validation = validateCurve(body.data.curve);
    if (!validation.ok) {
      // Courbe refusée : la courbe précédente reste en place.
      return errorResponse(reply, 400, 'INVALID_CURVE', 'Courbe refusée.', validation.errors);
    }

    const id = idParsed.data;
    const previous = ctx.repos.fanConfigs.get(id)!;
    const next: FanConfig = { ...previous, curve: validation.curve! };
    ctx.repos.fanConfigs.upsert(next);
    try {
      await ctx.fans.send('reload');
    } catch (err) {
      // L'écriture en base est conservée : le moteur la relira à son réveil.
      if (!(err instanceof FanEngineUnavailable)) {
        ctx.repos.fanConfigs.upsert(previous);
        return respondEngineError(reply, err);
      }
    }
    ctx.repos.events.append({
      category: 'curve', level: 'normal', targetLabel: next.displayName,
      message: 'Courbe de ventilation modifiée',
    });
    ctx.publish('fan.curve_changed');
    return { ok: true, curve: validation.curve };
  });

  app.put('/api/fans/:id/mode', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = modeSchema.safeParse(request.body);
    if (!body.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Mode invalide.', body.error.issues);
    }
    const id = idParsed.data;
    const current = ctx.repos.fanConfigs.get(id)!;
    const next: FanConfig = {
      ...current,
      mode: body.data.mode,
      manualPwm: body.data.manualPwm ?? current.manualPwm,
    };
    ctx.repos.fanConfigs.upsert(next);
    try {
      await ctx.fans.send('reload');
    } catch (err) {
      if (!(err instanceof FanEngineUnavailable)) return respondEngineError(reply, err);
    }
    ctx.repos.events.append({
      category: 'fan', level: 'normal', targetLabel: next.displayName,
      message: `Mode de ventilation : ${next.mode}`,
    });
    ctx.publish('fan.mode_changed');
    return { ok: true, config: next };
  });

  // =====================================================================
  // Actions immédiates
  // =====================================================================

  app.post('/api/fans/:id/test', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = z.object({ seconds: z.number().int().min(1).max(120).default(30) }).safeParse(request.body ?? {});
    const seconds = body.success ? body.data.seconds : 30;
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('startTest', { fanId: idParsed.data, seconds });
      if (!result.ok) return errorResponse(reply, 409, 'TEST_REFUSED', result.error ?? 'Test refusé.');
      ctx.publish('fan.updated');
      return { ok: true, seconds };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  app.post('/api/fans/:id/stop-test', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      await ctx.fans.send('stopTest', { fanId: idParsed.data });
      ctx.publish('fan.updated');
      return { ok: true };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  app.post('/api/fans/:id/force-max', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    const body = z.object({ seconds: z.number().int().min(1).max(600).optional() }).safeParse(request.body ?? {});
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('forceMax', {
        fanId: idParsed.data,
        seconds: body.success ? body.data.seconds : undefined,
      });
      if (!result.ok) return errorResponse(reply, 409, 'FORCE_REFUSED', result.error ?? 'Forçage refusé.');
      ctx.publish('fan.updated');
      return { ok: true };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  app.post('/api/fans/:id/clear-force-max', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      await ctx.fans.send('clearForceMax', { fanId: idParsed.data });
      ctx.publish('fan.updated');
      return { ok: true };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  app.post('/api/fans/:id/return-to-bios', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('returnToBios', { fanId: idParsed.data });
      ctx.publish('fan.updated');
      if (!result.ok) {
        return errorResponse(reply, 409, 'BIOS_RETURN_UNCONFIRMED', result.error ?? 'Retour BIOS non confirmé.');
      }
      return { ok: true };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  app.post('/api/fans/:id/take-software-control', sensitive, async (request, reply) => {
    const idParsed = fanIdSchema.safeParse((request.params as { id: string }).id);
    if (!idParsed.success) return errorResponse(reply, 404, 'NOT_FOUND', 'Sortie inconnue.');
    try {
      const result = await ctx.fans.send<{ ok: boolean; error?: string }>('takeSoftwareControl', { fanId: idParsed.data });
      ctx.publish('fan.updated');
      if (!result.ok) return errorResponse(reply, 409, 'CONTROL_REFUSED', result.error ?? 'Prise de contrôle refusée.');
      return { ok: true };
    } catch (err) {
      return respondEngineError(reply, err);
    }
  });

  // =====================================================================
  // Profils
  // =====================================================================

  app.get('/api/fan-profiles', async () => ({
    profiles: ctx.repos.profiles.list(),
    activeProfileId: ctx.repos.settings.get<string>('activeProfileId', 'p-balanced'),
  }));

  app.post('/api/fan-profiles', sensitive, async (request, reply) => {
    const parsed = profileBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Profil invalide.', parsed.error.issues);
    }
    // Sans courbes fournies, on capture les courbes actuellement appliquées.
    const raw = parsed.data.curves
      ?? Object.fromEntries(ctx.repos.fanConfigs.list().map((c) => [c.id, c.curve]));
    const validation = validateProfileCurves(raw as Record<string, unknown>);
    if (!validation.ok) {
      return errorResponse(reply, 400, 'INVALID_CURVE', 'Courbes de profil refusées.', validation.errors);
    }
    const profile: FanProfile = { id: newId('prof'), name: parsed.data.name, builtin: false, curves: validation.curves };
    ctx.repos.profiles.upsert(profile);
    ctx.publish('fan.curve_changed');
    return reply.code(201).send(profile);
  });

  app.put('/api/fan-profiles/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = ctx.repos.profiles.get(id);
    if (!existing) return errorResponse(reply, 404, 'NOT_FOUND', 'Profil inconnu.');
    const parsed = profileBodySchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Profil invalide.', parsed.error.issues);
    }
    if (existing.builtin) {
      // Un profil prédéfini n'est jamais modifié : on en crée une copie personnalisée.
      const raw = parsed.data.curves ?? existing.curves;
      const validation = validateProfileCurves(raw as Record<string, unknown>);
      if (!validation.ok) {
        return errorResponse(reply, 400, 'INVALID_CURVE', 'Courbes refusées.', validation.errors);
      }
      const copy: FanProfile = {
        id: newId('prof'),
        name: parsed.data.name ?? `${existing.name} (personnalisé)`,
        builtin: false,
        curves: validation.curves,
      };
      ctx.repos.profiles.upsert(copy);
      ctx.repos.settings.set('activeProfileId', copy.id);
      ctx.publish('fan.curve_changed');
      return reply.code(201).send({ ...copy, derivedFrom: existing.id });
    }
    const raw = parsed.data.curves ?? existing.curves;
    const validation = validateProfileCurves(raw as Record<string, unknown>);
    if (!validation.ok) {
      return errorResponse(reply, 400, 'INVALID_CURVE', 'Courbes refusées.', validation.errors);
    }
    const updated: FanProfile = { ...existing, name: parsed.data.name ?? existing.name, curves: validation.curves };
    ctx.repos.profiles.upsert(updated);
    ctx.publish('fan.curve_changed');
    return { ok: true, profile: updated };
  });

  app.delete('/api/fan-profiles/:id', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    if ((BUILTIN_PROFILE_IDS as readonly string[]).includes(id)) {
      return errorResponse(reply, 409, 'BUILTIN_PROFILE', 'Un profil prédéfini ne peut pas être supprimé.');
    }
    if (!ctx.repos.profiles.remove(id)) return errorResponse(reply, 404, 'NOT_FOUND', 'Profil inconnu.');
    if (ctx.repos.settings.get<string>('activeProfileId', '') === id) {
      ctx.repos.settings.set('activeProfileId', 'p-balanced');
    }
    ctx.publish('fan.curve_changed');
    return { ok: true };
  });

  app.post('/api/fan-profiles/:id/duplicate', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = ctx.repos.profiles.get(id);
    if (!source) return errorResponse(reply, 404, 'NOT_FOUND', 'Profil inconnu.');
    const copy: FanProfile = {
      id: newId('prof'),
      name: `${source.name} (copie)`,
      builtin: false,
      curves: structuredClone(source.curves),
    };
    ctx.repos.profiles.upsert(copy);
    ctx.publish('fan.curve_changed');
    return reply.code(201).send(copy);
  });

  /** Application globale ou ciblée sur une sortie. */
  app.post('/api/fan-profiles/:id/apply', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = ctx.repos.profiles.get(id);
    if (!profile) return errorResponse(reply, 404, 'NOT_FOUND', 'Profil inconnu.');
    const body = z.object({ fanId: fanIdSchema.optional() }).safeParse(request.body ?? {});
    const targetFan = body.success ? body.data.fanId : undefined;

    const previous = ctx.repos.fanConfigs.list();
    const targets = targetFan ? previous.filter((c) => c.id === targetFan) : previous;
    const errors: string[] = [];
    const next: FanConfig[] = [];

    for (const cfg of targets) {
      const validation = validateCurve(profile.curves[cfg.id]);
      if (!validation.ok) {
        errors.push(`${cfg.id} : ${validation.errors.join(' ')}`);
        continue;
      }
      next.push({ ...cfg, curve: validation.curve! });
    }
    if (errors.length) {
      return errorResponse(reply, 400, 'INVALID_CURVE', 'Profil contenant des courbes invalides.', errors);
    }

    ctx.repos.fanConfigs.replaceAll(next);
    if (!targetFan) ctx.repos.settings.set('activeProfileId', profile.id);
    try {
      await ctx.fans.send('reload');
    } catch (err) {
      if (!(err instanceof FanEngineUnavailable)) {
        // Retour arrière transactionnel.
        ctx.repos.fanConfigs.replaceAll(previous);
        return respondEngineError(reply, err);
      }
    }
    ctx.repos.history.addMarker({ t: Date.now(), label: `Profil : ${profile.name}`, kind: 'profile' });
    ctx.repos.events.append({
      category: 'profile', level: 'normal', targetLabel: profile.name,
      message: targetFan ? `Profil appliqué à ${targetFan}` : 'Changement de profil de ventilation',
    });
    ctx.publish('fan.curve_changed');
    return { ok: true, applied: next.map((c) => c.id) };
  });

  /** Restaure la définition d'origine d'un profil prédéfini. */
  app.post('/api/fan-profiles/:id/restore', sensitive, async (request, reply) => {
    const { id } = request.params as { id: string };
    const builtin = builtinProfiles().find((p) => p.id === id);
    if (!builtin) return errorResponse(reply, 404, 'NOT_BUILTIN', 'Seuls les profils prédéfinis sont restaurables.');
    ctx.repos.profiles.upsert(builtin);
    ctx.repos.events.append({
      category: 'profile', level: 'normal', targetLabel: builtin.name, message: 'Profil prédéfini restauré',
    });
    ctx.publish('fan.curve_changed');
    return { ok: true, profile: builtin };
  });
}
