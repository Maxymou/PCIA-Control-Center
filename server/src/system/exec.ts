/** Exécution d'outils système.
 *
 *  Toujours par `execFile` avec un tableau d'arguments : jamais de shell, donc
 *  aucune interpolation possible. Aucune commande ne provient du navigateur —
 *  seule cette liste blanche est utilisée par le back-end.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('exec');

/** Outils externes que le back-end sait exploiter. Rien d'autre n'est lancé. */
export const KNOWN_TOOLS = [
  'nvidia-smi', 'lspci', 'lsblk', 'smartctl', 'nvme', 'sensors',
  'systemctl', 'docker', 'ss', 'dmidecode',
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

const SEARCH_PATHS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/local/sbin', '/opt/bin'];

const toolPathCache = new Map<string, string | null>();

/** Résout le chemin absolu d'un outil, sans passer par `which` (pas de shell). */
export function resolveTool(tool: KnownTool): string | null {
  if (toolPathCache.has(tool)) return toolPathCache.get(tool)!;
  let found: string | null = null;
  const envPaths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of [...envPaths, ...SEARCH_PATHS]) {
    const candidate = `${dir}/${tool}`;
    if (existsSync(candidate)) {
      found = candidate;
      break;
    }
  }
  toolPathCache.set(tool, found);
  return found;
}

export function hasTool(tool: KnownTool): boolean {
  return resolveTool(tool) !== null;
}

/** Réinitialise le cache — utile après une installation de paquet. */
export function clearToolCache(): void {
  toolPathCache.clear();
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Taille max de sortie acceptée (protection mémoire). */
  maxBuffer?: number;
}

/** Version asynchrone — à privilégier dans l'API. */
export async function run(tool: KnownTool, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const path = resolveTool(tool);
  if (!path) return { ok: false, stdout: '', stderr: '', error: `Outil absent : ${tool}` };
  try {
    const { stdout, stderr } = await execFileAsync(path, args, {
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    log.throttled(`${tool}-fail`, 60_000, 'debug', 'Commande en échec', { tool, args, error: e.message });
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message };
  }
}

/** Version synchrone — réservée à la CLI et au démarrage. */
export function runSync(tool: KnownTool, args: string[], opts: RunOptions = {}): RunResult {
  const path = resolveTool(tool);
  if (!path) return { ok: false, stdout: '', stderr: '', error: `Outil absent : ${tool}` };
  try {
    const stdout = execFileSync(path, args, {
      timeout: opts.timeoutMs ?? 5000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message };
  }
}

/** Découpe une sortie CSV `nvidia-smi` (`--format=csv,noheader,nounits`). */
export function parseCsvLine(line: string): string[] {
  return line.split(',').map((s) => s.trim());
}

/** Convertit une valeur nvidia-smi en nombre, en gérant `[N/A]`, `[Not Supported]`. */
export function numOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[[\]]/g, '').trim();
  if (!cleaned || /n\/a|not supported|unknown|insufficient/i.test(cleaned)) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
