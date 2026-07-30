/** Client HTTP et WebSocket du back-end PCIA Control Center.
 *
 *  Toute la communication réseau du front-end passe par ce module : aucun
 *  `fetch` n'est dispersé dans les composants. Les erreurs sont normalisées
 *  pour que la couche supérieure puisse les afficher sans les interpréter.
 */

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Base de l'API : même origine en production, surchargeable en développement. */
export function apiBase(): string {
  const injected = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PCIA_API;
  if (injected) return injected.replace(/\/$/, '');
  return '';
}

/** URL du WebSocket, dérivée de l'origine courante (même port que l'API). */
export function wsUrl(): string {
  const base = apiBase();
  if (base) {
    return `${base.replace(/^http/, 'ws')}/ws/live`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/live`;
}

/** Jeton optionnel pour les actions sensibles (mode `authMode: token`). */
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Réseau injoignable : distingué d'une erreur applicative.
    throw new ApiError(0, 'NETWORK_ERROR', (err as Error).message);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errorBody = parsed as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      errorBody?.error ?? 'HTTP_ERROR',
      errorBody?.message ?? `${response.status} ${response.statusText}`,
      errorBody?.details,
    );
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// =====================================================================
// WebSocket avec reconnexion
// =====================================================================

export interface LiveMessage<T = unknown> {
  type: string;
  timestamp: number;
  schema: number;
  payload: T;
}

export interface LiveSocketHandlers {
  onMessage(message: LiveMessage): void;
  onOpen?(): void;
  /** Appelé à chaque perte de connexion, avec le délai avant nouvel essai. */
  onClose?(retryInMs: number): void;
}

/** Connexion temps réel avec reconnexion exponentielle plafonnée. */
export class LiveSocket {
  private socket: WebSocket | null = null;
  private retryDelay = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private handlers: LiveSocketHandlers) {}

  connect(): void {
    this.closedByUs = false;
    try {
      this.socket = new WebSocket(wsUrl());
    } catch {
      this.scheduleRetry();
      return;
    }

    this.socket.onopen = () => {
      this.retryDelay = 1000;
      this.handlers.onOpen?.();
      // Ping applicatif : maintient la connexion à travers les proxys.
      this.pingTimer = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('{"type":"ping"}');
      }, 25_000);
    };

    this.socket.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(event.data as string) as LiveMessage);
      } catch {
        // Message illisible : ignoré, la resynchronisation REST reste possible.
      }
    };

    this.socket.onclose = () => {
      this.clearPing();
      if (this.closedByUs) return;
      this.scheduleRetry();
    };

    this.socket.onerror = () => {
      // `onclose` suit toujours : la reconnexion y est planifiée.
    };
  }

  private scheduleRetry(): void {
    const delay = this.retryDelay;
    this.handlers.onClose?.(delay);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    this.closedByUs = true;
    this.clearPing();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
