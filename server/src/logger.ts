/** Journalisation structurée.
 *
 *  Sortie JSON une ligne par enregistrement (exploitable par journald / jq),
 *  ou texte lisible si `PCIA_LOG_FORMAT=text`.
 *
 *  Règle : le fonctionnement normal ne doit PAS produire une ligne par seconde.
 *  Les boucles chaudes utilisent `throttled()` qui déduplique par clé.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = (process.env.PCIA_LOG_LEVEL as LogLevel) || 'info';
let format: 'json' | 'text' = process.env.PCIA_LOG_FORMAT === 'text' ? 'text' : 'json';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setLogFormat(f: 'json' | 'text'): void {
  format = f;
}

function write(level: LogLevel, component: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const time = new Date().toISOString();
  if (format === 'text') {
    const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${component}] ${message}${extra}`;
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    return;
  }
  const record = { time, level, component, message, ...(fields ?? {}) };
  const line = JSON.stringify(record, jsonSafe);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

/** Les erreurs ne sont pas sérialisables telles quelles en JSON. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Écrit au plus une fois par `intervalMs` pour une clé donnée. */
  throttled(key: string, intervalMs: number, level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  child(sub: string): Logger;
}

const lastThrottle = new Map<string, number>();

export function createLogger(component: string): Logger {
  return {
    debug: (m, f) => write('debug', component, m, f),
    info: (m, f) => write('info', component, m, f),
    warn: (m, f) => write('warn', component, m, f),
    error: (m, f) => write('error', component, m, f),
    throttled(key, intervalMs, level, message, fields) {
      const k = `${component}:${key}`;
      const now = Date.now();
      const last = lastThrottle.get(k) ?? 0;
      if (now - last < intervalMs) return;
      lastThrottle.set(k, now);
      write(level, component, message, fields);
    },
    child: (sub) => createLogger(`${component}.${sub}`),
  };
}
