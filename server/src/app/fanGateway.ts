/** Passerelle vers le moteur de ventilation.
 *
 *  L'API ne pilote jamais les PWM elle-même : elle transmet des commandes au
 *  moteur, qu'il soit embarqué (même processus) ou externe (daemon `pcia-fand`
 *  via socket Unix). Si le moteur est injoignable, les commandes échouent
 *  proprement — la régulation, elle, continue de son côté.
 */

import { fanSocketPath, fanStatePath, type AppConfig } from '../config.js';
import type { FanEngineState } from '../contract.js';
import type { FanHost } from '../fan/host.js';
import { FanIpcClient, readStateFile, type IpcCommand } from '../fan/ipc.js';

export class FanEngineUnavailable extends Error {
  constructor(cause?: string) {
    super(cause ?? 'Moteur de ventilation injoignable.');
    this.name = 'FanEngineUnavailable';
  }
}

export class FanGateway {
  private client: FanIpcClient;

  constructor(private config: AppConfig, private embedded: FanHost | null) {
    this.client = new FanIpcClient(fanSocketPath(config));
  }

  isEmbedded(): boolean {
    return this.embedded !== null;
  }

  /** Le moteur répond-il ? (socket présent ou moteur embarqué). */
  available(): boolean {
    return this.embedded !== null || this.client.available();
  }

  /** Dernier état publié, sans commande — lecture du fichier d'état. */
  lastState(): FanEngineState | null {
    if (this.embedded) return this.embedded.state();
    return readStateFile(fanStatePath(this.config));
  }

  online(): boolean {
    if (this.embedded) return true;
    const state = this.lastState();
    if (!state) return false;
    return Date.now() - state.heartbeat <= this.config.fanControl.heartbeatTimeoutMs;
  }

  /** Envoie une commande. Les commandes de calibration ont un délai plus long. */
  async send<T = unknown>(command: IpcCommand, params: Record<string, unknown> = {}): Promise<T> {
    if (this.embedded) {
      return await this.embedded.handleCommand(command, params) as T;
    }
    if (!this.client.available()) throw new FanEngineUnavailable();
    const timeout = command.startsWith('calibration.') ? 20_000 : 5000;
    try {
      return await this.client.request<T>(command, params, timeout);
    } catch (err) {
      const message = (err as Error).message;
      if (/socket absent|ENOENT|ECONNREFUSED|fermée avant réponse/.test(message)) {
        throw new FanEngineUnavailable(message);
      }
      throw err;
    }
  }
}
