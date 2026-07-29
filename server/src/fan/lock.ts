/** Verrou exclusif du moteur de ventilation.
 *
 *  Garantit qu'**un seul processus** écrit les sorties PWM : le daemon
 *  `pcia-fand` et le moteur embarqué de l'API ne peuvent jamais tourner
 *  simultanément. Un verrou dont le processus a disparu est repris.
 */

import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('fan.lock');

export function lockPath(runtimeDir: string): string {
  return join(runtimeDir, 'fan-engine.lock');
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 : ne tue pas, teste seulement l'existence et les permissions.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface FanLock {
  path: string;
  release(): void;
}

export interface LockAttempt {
  acquired: boolean;
  lock: FanLock | null;
  /** PID détenteur si le verrou est déjà pris. */
  heldBy: number | null;
}

export function acquireFanLock(runtimeDir: string): LockAttempt {
  const path = lockPath(runtimeDir);
  mkdirSync(dirname(path), { recursive: true });

  const tryCreate = (): LockAttempt | null => {
    try {
      // 'wx' échoue si le fichier existe déjà : c'est l'exclusion mutuelle.
      const fd = openSync(path, 'wx', 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        acquired: true,
        heldBy: process.pid,
        lock: {
          path,
          release() {
            try {
              if (existsSync(path) && readFileSync(path, 'utf8').trim() === String(process.pid)) {
                unlinkSync(path);
              }
            } catch (err) {
              log.warn('Libération du verrou impossible', { path, error: err });
            }
          },
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.error('Création du verrou impossible', { path, error: err });
        return { acquired: false, lock: null, heldBy: null };
      }
      return null;
    }
  };

  const first = tryCreate();
  if (first) return first;

  // Verrou existant : le détenteur est-il encore vivant ?
  let heldBy: number | null = null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    heldBy = Number.isFinite(pid) ? pid : null;
  } catch {
    heldBy = null;
  }

  if (heldBy !== null && processAlive(heldBy)) {
    return { acquired: false, lock: null, heldBy };
  }

  log.warn('Verrou orphelin repris', { path, stalePid: heldBy });
  try {
    unlinkSync(path);
  } catch {
    /* course : un autre processus l'a peut-être repris */
  }
  return tryCreate() ?? { acquired: false, lock: null, heldBy };
}
