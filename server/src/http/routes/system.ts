/** Routes système : santé, état, matériel, capteurs, diagnostic. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../context.js';
import { APP_VERSION, HISTORY_WINDOW_MS } from '../../app/state.js';
import { errorResponse, requireSensitive } from '../security.js';
import { readSystemInfo } from '../../system/info.js';
import { hasTool, KNOWN_TOOLS } from '../../system/exec.js';
import { currentSchemaVersion, SCHEMA_VERSION } from '../../db/database.js';
import type { HardwareId } from '../../contract.js';

const sensorOverrideSchema = z.object({
  target: z.enum(['cpu', 'nvme', 'motherboard', 'case-front', 'case-rear']),
  sensorKey: z.string().min(1).max(200).nullable(),
});

export async function registerSystemRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const sensitive = { preHandler: requireSensitive(ctx.config) };

  /** Sonde de vie — volontairement minimale et sans accès disque. */
  app.get('/api/health', async () => ({
    status: 'ok',
    version: APP_VERSION,
    mode: ctx.env.mode,
    uptimeSeconds: Math.round(process.uptime()),
    fanEngineOnline: ctx.fans.online(),
  }));

  app.get('/api/system/status', async () => ctx.state.snapshot().system);

  app.get('/api/system/capabilities', async () => ctx.state.snapshot().system.capabilities);

  /** Snapshot complet — sert aussi de resynchronisation si le WebSocket coupe. */
  app.get('/api/snapshot', async () => ctx.state.snapshot());

  app.get('/api/hardware', async () => ({
    items: ctx.state.snapshot().hardware,
    warnings: ctx.env.degradedReasons,
  }));

  app.get('/api/hardware/cpu', async (_req, reply) => {
    const cpu = ctx.state.snapshot().hardware.find((h) => h.id === 'cpu');
    if (!cpu) return errorResponse(reply, 404, 'NOT_FOUND', 'Aucune information CPU disponible.');
    return cpu;
  });

  app.get('/api/hardware/gpus', async () => ({
    gpus: ctx.state.hardwareInventory().gpuList(),
    slots: ctx.repos.settings.get('gpuSlots', {}),
  }));

  app.get('/api/hardware/storage', async () => ctx.state.hardwareInventory().storageSummary() ?? { devices: [], primary: null });

  /** Capteurs découverts et leur rattachement aux emplacements de l'interface. */
  app.get('/api/sensors', async () => {
    const discovery = ctx.env.hwmon.cached();
    const inventory = ctx.state.hardwareInventory().build();
    return {
      controllers: discovery.controllers,
      sensors: inventory.annotatedSensors,
      pwmOutputs: discovery.pwmOutputs,
      orphanTachs: discovery.orphanTachs,
      mapping: inventory.sensorMap,
      warnings: [...discovery.warnings, ...inventory.warnings],
    };
  });

  app.put('/api/sensors/mapping', sensitive, async (request, reply) => {
    const parsed = sensorOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return errorResponse(reply, 400, 'VALIDATION_ERROR', 'Association de capteur invalide.', parsed.error.issues);
    }
    const { target, sensorKey } = parsed.data;
    if (sensorKey && !ctx.env.hwmon.cached().tempSensors.some((s) => s.key === sensorKey)) {
      return errorResponse(reply, 400, 'UNKNOWN_SENSOR', 'Capteur inconnu.');
    }
    ctx.state.hardwareInventory().setSensorOverride(target as HardwareId, sensorKey);
    ctx.repos.events.append({
      category: 'config', level: 'normal', targetLabel: target,
      message: sensorKey ? 'Capteur associé manuellement' : 'Association de capteur réinitialisée',
    });
    ctx.publish('sensor.updated');
    return { ok: true };
  });

  /** Redécouverte explicite du matériel. */
  app.post('/api/hardware/refresh', sensitive, async () => {
    ctx.env.hwmon.discover();
    await ctx.state.hardwareInventory().refreshStatic();
    try {
      await ctx.fans.send('rediscover');
    } catch {
      // Le moteur peut être hors ligne : ce n'est pas bloquant pour la supervision.
    }
    await ctx.state.refreshSources();
    ctx.emit('hardware.updated', { time: Date.now() });
    return { ok: true, discovery: ctx.env.hwmon.cached() };
  });

  app.get('/api/history', async (request) => {
    const query = request.query as { minutes?: string };
    const minutes = Math.max(1, Math.min(1440, Number(query.minutes ?? 60) || 60));
    const from = Date.now() - minutes * 60_000;
    return {
      windowMinutes: minutes,
      maxWindowMs: HISTORY_WINDOW_MS,
      points: ctx.repos.history.range(from),
      markers: ctx.repos.history.markers(from),
      retentionHours: ctx.config.history.retentionHours,
    };
  });

  /** Rapport de diagnostic — sans secret, exportable tel quel. */
  app.get('/api/diagnostics', async () => buildDiagnostics(ctx));
}

export function buildDiagnostics(ctx: ApiContext): Record<string, unknown> {
  const info = readSystemInfo(true);
  const discovery = ctx.env.hwmon.cached();
  const snapshot = ctx.state.snapshot();
  const config = ctx.config;

  return {
    generatedAt: new Date().toISOString(),
    application: {
      version: APP_VERSION,
      mode: ctx.env.mode,
      degraded: ctx.env.degraded,
      degradedReasons: ctx.env.degradedReasons,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
    },
    system: {
      hostname: info.hostname,
      kernel: info.kernel,
      distribution: info.distribution,
      bios: info.biosVersion,
      board: [info.boardVendor, info.boardName].filter(Boolean).join(' ') || null,
    },
    tools: Object.fromEntries(KNOWN_TOOLS.map((t) => [t, hasTool(t)])),
    hwmon: {
      controllers: discovery.controllers.map((c) => ({
        key: c.key, driver: c.driverName, kernelDriver: c.kernelDriver,
        bus: c.bus, address: c.address, currentPath: c.currentPath,
      })),
      pwmOutputs: discovery.pwmOutputs.map((o) => ({
        key: o.key, index: o.index, writable: o.writable,
        enableMode: o.currentEnableMode, hasTach: o.tachPath !== null, label: o.label,
      })),
      tempSensors: discovery.tempSensors.map((s) => ({
        key: s.key, label: s.label, value: s.valueC, mappedTo: s.mappedTo,
      })),
      warnings: discovery.warnings,
    },
    gpus: ctx.state.hardwareInventory().gpuList().map((g) => ({
      uuid: g.uuid, name: g.name, pci: g.pciBusId, driver: g.driverVersion,
      cuda: g.cudaVersion, temp: g.tempC, power: g.powerW, memoryTotalGb: g.memoryTotalGb,
    })),
    storage: ctx.state.hardwareInventory().storageSummary()?.devices.map((d) => ({
      device: d.device, model: d.model, capacityGb: d.capacityGb,
      health: d.healthPercent, smartOk: d.smartOk, powerOnHours: d.powerOnHours,
      // Le numéro de série est volontairement omis du rapport.
    })) ?? [],
    fanEngine: {
      online: ctx.fans.online(),
      embedded: ctx.fans.isEmbedded(),
      state: ctx.fans.lastState(),
    },
    calibration: ctx.repos.calibration.list(),
    services: {
      total: snapshot.services.length,
      byStatus: countBy(snapshot.services.map((s) => s.status)),
    },
    connections: {
      total: snapshot.connections.length,
      byOrigin: countBy(snapshot.connections.map((c) => c.origin)),
      conflicts: snapshot.conflicts.length,
    },
    alerts: {
      active: snapshot.alerts.filter((a) => a.active).length,
      critical: snapshot.alerts.filter((a) => a.active && a.level === 'critical').length,
    },
    database: {
      path: config.storage.databasePath,
      schemaVersion: currentSchemaVersion(ctx.repos.db),
      expectedSchemaVersion: SCHEMA_VERSION,
      historyPoints: ctx.repos.history.range(0).length,
    },
    // Configuration anonymisée : aucun jeton, aucun secret.
    configuration: {
      server: { host: config.server.host, port: config.server.port },
      mode: config.mode,
      history: config.history,
      collector: config.collector,
      fanControl: config.fanControl,
      calibration: config.calibration,
      alerts: config.alerts,
      security: {
        lanOnly: config.security.lanOnly,
        authMode: config.security.authMode,
        tokenConfigured: Boolean(config.security.token),
        allowSensitiveActions: config.security.allowSensitiveActions,
      },
      logging: config.logging,
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
