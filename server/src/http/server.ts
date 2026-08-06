/** Serveur HTTP : front-end compilé, API REST et WebSocket sur le **même port**.
 *
 *  http://IP_PCIA:4321/        → interface
 *  http://IP_PCIA:4321/api/…   → API REST
 *  ws://IP_PCIA:4321/ws/live   → flux temps réel
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { appRoot } from '../config.js';
import type { WsMessageType } from '../contract.js';
import { createLogger } from '../logger.js';
import type { ApiContext } from './context.js';
import { lanGuard } from './security.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerFanRoutes } from './routes/fans.js';
import { registerCalibrationRoutes } from './routes/calibration.js';
import { registerMiscRoutes } from './routes/misc.js';

const log = createLogger('http');

/** Localise le front-end compilé (`dist/`). */
export function resolveStaticDir(config: AppConfig): string | null {
  const candidates = [
    config.server.staticDir,
    join(appRoot(), 'dist'),
    join(process.cwd(), 'dist'),
    '/usr/share/pcia-control-center/dist',
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export async function buildHttpServer(ctx: ApiContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Le front-end peut pousser une disposition de graphe volumineuse.
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: false,
  });

  // ---------- Garde réseau ----------
  app.addHook('onRequest', lanGuard(ctx.config));

  // ---------- CORS (développement avec le serveur Vite) ----------
  const origins = ctx.config.server.corsOrigins;
  if (origins.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && origins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PCIA-Token');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      }
      if (request.method === 'OPTIONS') {
        await reply.code(204).send();
      }
    });
  }

  // ---------- En-têtes de sécurité ----------
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });

  // ---------- API ----------
  await registerSystemRoutes(app, ctx);
  await registerServiceRoutes(app, ctx);
  await registerFanRoutes(app, ctx);
  await registerCalibrationRoutes(app, ctx);
  await registerMiscRoutes(app, ctx);

  // ---------- WebSocket ----------
  app.get('/ws/live', { websocket: true }, (socket) => {
    ctx.ws.add(socket as never);
  });

  // ---------- Front-end ----------
  const staticDir = resolveStaticDir(ctx.config);
  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      index: ['index.html'],
      // Les assets Vite sont horodatés : cache long, index.html jamais caché.
      //
      // `sw.js` et `manifest.webmanifest` doivent également échapper au cache du
      // navigateur : un service worker figé par un cache HTTP survivrait à un
      // redéploiement et continuerait de servir l'ancienne interface. C'est
      // aussi ce qui rend le retour arrière possible (cf. docs/ROLLBACK.md).
      setHeaders(reply, path) {
        if (path.endsWith('index.html')) reply.header('Cache-Control', 'no-cache');
        else if (path.endsWith('/sw.js') || path.endsWith('manifest.webmanifest')) {
          reply.header('Cache-Control', 'no-cache');
        } else if (path.includes('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    log.info('Front-end servi', { staticDir });
  } else {
    log.warn('Front-end compilé introuvable — exécuter `npm run build:web`. Seule l’API est disponible.');
  }

  // ---------- 404 : SPA ----------
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `Route inconnue : ${request.method} ${request.url}` });
    }
    if (staticDir) {
      // Routage côté client : toute autre URL renvoie l'application.
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(503).send({
      error: 'FRONTEND_NOT_BUILT',
      message: 'Front-end non compilé. Exécuter `npm run build:web`.',
    });
  });

  // ---------- Erreurs ----------
  app.setErrorHandler(async (error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      log.error('Erreur de requête', { url: request.url, method: request.method, error });
    }
    return reply.code(status).send({
      error: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      // Une erreur interne ne doit pas fuiter de détail d'implémentation.
      message: status >= 500 ? 'Erreur interne du serveur.' : error.message,
    });
  });

  return app;
}

/** Types utilitaires réexportés pour les modules de routes. */
export type { WsMessageType };
