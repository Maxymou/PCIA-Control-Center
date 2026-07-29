/** Contrôle d'accès.
 *
 *  L'application est conçue pour un **réseau local**. Deux garde-fous :
 *   - `lanOnly` (actif par défaut) refuse les requêtes venant d'adresses
 *     non privées : l'application n'est jamais exposée publiquement par défaut ;
 *   - les **actions sensibles** (calibration, PWM, profils, seuils, import de
 *     configuration, actions sur les services) peuvent exiger un jeton.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('http.security');

/** Plages privées RFC1918, loopback, lien-local et ULA IPv6. */
export function isPrivateAddress(address: string): boolean {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/, '');
  if (addr === '::1' || addr === 'localhost') return true;
  if (/^127\./.test(addr)) return true;
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^169\.254\./.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  if (/^fe80:/i.test(addr)) return true;
  return false;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface SecurityContext {
  config: AppConfig;
}

/** Refuse les requêtes hors réseau local quand `lanOnly` est actif. */
export function lanGuard(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.security.lanOnly) return;
    const ip = request.ip;
    if (isPrivateAddress(ip)) return;
    log.throttled(`lan-${ip}`, 60_000, 'warn', 'Requête refusée : adresse hors réseau local', { ip, url: request.url });
    await reply.code(403).send({
      error: 'FORBIDDEN_NETWORK',
      message: 'Accès restreint au réseau local. Modifier `security.lan_only` pour changer ce comportement.',
    });
  };
}

/** Exige le jeton pour une action sensible, si `authMode = token`. */
export function requireSensitive(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.security.allowSensitiveActions) {
      await reply.code(403).send({
        error: 'SENSITIVE_ACTIONS_DISABLED',
        message: 'Les actions sensibles sont désactivées dans la configuration du serveur.',
      });
      return;
    }
    if (config.security.authMode !== 'token') return;
    const expected = config.security.token;
    if (!expected) {
      await reply.code(500).send({
        error: 'AUTH_MISCONFIGURED',
        message: 'Mode jeton activé sans jeton configuré : action refusée.',
      });
      return;
    }
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ')
      ? header.slice(7)
      : (request.headers['x-pcia-token'] as string | undefined) ?? '';
    if (!provided || !constantTimeEquals(provided, expected)) {
      await reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Jeton requis pour cette action.',
      });
    }
  };
}

/** Réponse d'erreur structurée et homogène. */
export function errorResponse(reply: FastifyReply, status: number, error: string, message: string, details?: unknown) {
  return reply.code(status).send({ error, message, ...(details === undefined ? {} : { details }) });
}
