/** Canal de commande du moteur de ventilation (socket Unix local).
 *
 *  Protocole : JSON délimité par des sauts de ligne.
 *  Le socket est local et restreint par les permissions du système de fichiers ;
 *  aucune commande arbitraire n'est acceptée — uniquement la liste ci-dessous,
 *  avec des paramètres validés côté serveur.
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';
import type { FanEngineState } from '../contract.js';

const log = createLogger('fan.ipc');

/** Commandes acceptées. Toute autre valeur est rejetée. */
export const IPC_COMMANDS = [
  'ping',
  'getState',
  'reload',
  'rediscover',
  'startTest',
  'stopTest',
  'forceMax',
  'clearForceMax',
  'returnToBios',
  'takeSoftwareControl',
  'calibration.discover',
  'calibration.sessions',
  'calibration.start',
  'calibration.identify',
  'calibration.confirmIdentification',
  'calibration.testRpm',
  'calibration.detectMinimum',
  'calibration.testSoftwareControl',
  'calibration.testBiosReturn',
  'calibration.authorize',
  'calibration.cancel',
  'calibration.emergencyStop',
  'calibration.reset',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export interface IpcRequest {
  id: string;
  command: IpcCommand;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type IpcHandler = (command: IpcCommand, params: Record<string, unknown>) => Promise<unknown> | unknown;

/** Longueur maximale d'un chemin de socket Unix (`sun_path`, NUL compris). */
export const MAX_SOCKET_PATH_BYTES = 107;

/** Le noyau tronque silencieusement un chemin trop long : le serveur écouterait
 *  alors sur un fichier que le client ne trouverait jamais. On le détecte. */
export function checkSocketPath(path: string): { ok: boolean; error?: string } {
  const length = Buffer.byteLength(path, 'utf8');
  if (length <= MAX_SOCKET_PATH_BYTES) return { ok: true };
  return {
    ok: false,
    error: `Chemin de socket trop long (${length} octets, maximum ${MAX_SOCKET_PATH_BYTES}) : ${path}. `
      + 'Le noyau le tronquerait et le moteur deviendrait injoignable. '
      + 'Choisir un `storage.runtime_dir` plus court (ex. /run/pcia-control-center).',
  };
}

// =====================================================================
// Serveur (côté moteur)
// =====================================================================

export class FanIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();

  constructor(private socketPath: string, private handler: IpcHandler) {}

  start(): void {
    const check = checkSocketPath(this.socketPath);
    if (!check.ok) {
      // Échec explicite plutôt qu'un canal de commande silencieusement inutile.
      // La régulation, elle, continue : seul le pilotage à distance est perdu.
      log.error('Canal de commande non ouvert', { reason: check.error });
      return;
    }
    mkdirSync(dirname(this.socketPath), { recursive: true });
    // Un socket résiduel d'un processus mort empêcherait l'écoute.
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        log.warn('Socket résiduel non supprimé', { path: this.socketPath, error: err });
      }
    }

    this.server = createServer((socket) => {
      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // Garde-fou : une requête légitime tient largement en 64 Kio.
        if (buffer.length > 65_536) {
          socket.destroy();
          return;
        }
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim()) void this.handleLine(socket, line);
        }
      });
    });

    this.server.listen(this.socketPath, () => {
      // Lecture/écriture pour le propriétaire et son groupe uniquement.
      // Sur certains systèmes de fichiers, le nœud n'est pas immédiatement
      // visible après le bind : une seconde tentative suffit.
      const applyPermissions = (retry: boolean) => {
        try {
          chmodSync(this.socketPath, 0o660);
        } catch (err) {
          if (retry && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            setTimeout(() => applyPermissions(false), 50);
            return;
          }
          log.warn('Permissions du socket non appliquées', { path: this.socketPath, error: err });
        }
      };
      applyPermissions(true);
      log.info('Canal de commande ouvert', { path: this.socketPath });
    });

    this.server.on('error', (err) => {
      log.error('Erreur du canal de commande', { error: err });
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      this.send(socket, { id: 'unknown', ok: false, error: 'Requête JSON invalide' });
      return;
    }
    if (!request?.id || !IPC_COMMANDS.includes(request.command)) {
      this.send(socket, { id: request?.id ?? 'unknown', ok: false, error: `Commande refusée : ${request?.command}` });
      return;
    }
    try {
      const data = await this.handler(request.command, request.params ?? {});
      this.send(socket, { id: request.id, ok: true, data });
    } catch (err) {
      this.send(socket, { id: request.id, ok: false, error: (err as Error).message });
    }
  }

  private send(socket: Socket, response: IpcResponse): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  stop(): void {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* déjà supprimé */
      }
    }
  }
}

// =====================================================================
// Client (côté API)
// =====================================================================

export class FanIpcClient {
  constructor(private socketPath: string, private timeoutMs = 5000) {}

  available(): boolean {
    return checkSocketPath(this.socketPath).ok && existsSync(this.socketPath);
  }

  /** Envoie une commande. Une connexion par requête : simple et robuste. */
  request<T = unknown>(command: IpcCommand, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = checkSocketPath(this.socketPath);
      if (!check.ok) {
        reject(new Error(check.error));
        return;
      }
      if (!existsSync(this.socketPath)) {
        reject(new Error('Moteur de ventilation injoignable (socket absent).'));
        return;
      }
      const socket = createConnection(this.socketPath);
      const id = Math.random().toString(36).slice(2, 10);
      let buffer = '';
      let settled = false;

      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };

      const timer = setTimeout(
        () => finish(new Error(`Délai dépassé pour la commande ${command}`)),
        timeoutMs ?? this.timeoutMs,
      );

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id, command, params })}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, index)) as IpcResponse;
          if (response.ok) finish(null, response.data as T);
          else finish(new Error(response.error ?? 'Erreur inconnue'));
        } catch (err) {
          finish(err as Error);
        }
      });
      socket.on('error', (err) => finish(err));
      socket.on('close', () => finish(new Error('Connexion au moteur fermée avant réponse')));
    });
  }
}

// =====================================================================
// Fichier d'état (heartbeat lisible sans socket)
// =====================================================================

export function writeStateFile(path: string, state: FanEngineState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Écriture atomique : un lecteur ne doit jamais voir un JSON tronqué.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch (err) {
    log.throttled('state-write', 60_000, 'warn', 'Écriture du fichier d’état impossible', { path, error: err });
  }
}

export function readStateFile(path: string): FanEngineState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FanEngineState;
  } catch {
    return null;
  }
}
