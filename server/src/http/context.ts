/** Contexte partagé par les routes de l'API. */

import type { AppConfig } from '../config.js';
import type { WsMessageType } from '../contract.js';
import type { Repositories } from '../db/repositories.js';
import type { AppState } from '../app/state.js';
import type { FanGateway } from '../app/fanGateway.js';
import type { RuntimeEnv } from '../runtime.js';
import type { WsHub } from './ws.js';

export interface ApiContext {
  config: AppConfig;
  env: RuntimeEnv;
  repos: Repositories;
  state: AppState;
  fans: FanGateway;
  ws: WsHub;
  /** Recalcule le snapshot et le diffuse (après une action utilisateur). */
  publish(type?: WsMessageType): void;
  /** Diffuse un message ciblé sans recalculer tout le snapshot. */
  emit(type: WsMessageType, payload: unknown): void;
}
