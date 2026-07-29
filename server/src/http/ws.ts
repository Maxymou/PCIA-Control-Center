/** Diffusion temps réel sur `/ws/live`.
 *
 *  Messages typés `{ type, timestamp, schema, payload }`. Un client qui vient de
 *  se connecter reçoit immédiatement un `snapshot` complet : la reprise après
 *  coupure ne demande aucune logique particulière côté navigateur, et l'API REST
 *  reste disponible pour resynchroniser.
 */

import type { WebSocket } from 'ws';
import type { ServerSnapshot, WsMessage, WsMessageType } from '../contract.js';
import { WS_SCHEMA_VERSION } from '../contract.js';
import { createLogger } from '../logger.js';

const log = createLogger('http.ws');

/** Au-delà, on considère le client injoignable et on ferme la connexion. */
const PING_INTERVAL_MS = 20_000;

interface Client {
  socket: WebSocket;
  alive: boolean;
  connectedAt: number;
}

export class WsHub {
  private clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private snapshotProvider: () => ServerSnapshot) {}

  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!client.alive) {
          // Le client n'a pas répondu au ping précédent.
          this.clients.delete(client);
          try {
            client.socket.terminate();
          } catch {
            /* déjà fermé */
          }
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client);
        }
      }
    }, PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) {
      try {
        c.socket.close(1001, 'Arrêt du serveur');
      } catch {
        /* ignoré */
      }
    }
    this.clients.clear();
  }

  add(socket: WebSocket): void {
    const client: Client = { socket, alive: true, connectedAt: Date.now() };
    this.clients.add(client);

    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
    socket.on('message', (raw) => {
      // Le seul message accepté du client est un ping applicatif.
      const text = raw.toString().slice(0, 200);
      if (text.includes('ping')) {
        client.alive = true;
        this.sendTo(socket, 'pong', { time: Date.now() });
      }
    });

    // État complet immédiat : le client est utilisable dès la connexion.
    try {
      this.sendTo(socket, 'snapshot', this.snapshotProvider());
    } catch (err) {
      log.warn('Envoi du snapshot initial impossible', { error: err });
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  broadcast(type: WsMessageType, payload: unknown): void {
    if (this.clients.size === 0) return;
    const message: WsMessage = { type, timestamp: Date.now(), schema: WS_SCHEMA_VERSION, payload };
    const data = JSON.stringify(message);
    for (const client of [...this.clients]) {
      if (client.socket.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.socket.send(data);
      } catch (err) {
        log.throttled('send-fail', 60_000, 'warn', 'Envoi WebSocket en échec', { error: err });
        this.clients.delete(client);
      }
    }
  }

  private sendTo(socket: WebSocket, type: WsMessageType, payload: unknown): void {
    if (socket.readyState !== 1) return;
    const message: WsMessage = { type, timestamp: Date.now(), schema: WS_SCHEMA_VERSION, payload };
    socket.send(JSON.stringify(message));
  }
}
