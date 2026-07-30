/** Outils partagés par les tests.
 *
 *  Aucun test n'accède au matériel réel : tout passe par le backend hwmon
 *  simulé et une base SQLite temporaire.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type AppConfig } from '../src/config.js';
import { openAndMigrate } from '../src/db/database.js';
import { createRepositories, seedDefaults, type Repositories } from '../src/db/repositories.js';
import { SimulatedHwmonBackend } from '../src/hwmon/simulated.js';
import { DemoWorld } from '../src/demo/world.js';
import { seedDemoCalibration } from '../src/demo/calibration.js';

export interface TestEnv {
  dir: string;
  config: AppConfig;
  repos: Repositories;
  hwmon: SimulatedHwmonBackend;
  world: DemoWorld;
  cleanup(): void;
}

export function createTestEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pcia-test-'));
  const config = configSchema.parse({
    mode: { type: 'demo' },
    storage: { databasePath: join(dir, 'pcia.db'), runtimeDir: join(dir, 'run') },
    logging: { level: 'error' },
    ...overrides,
  });

  const world = new DemoWorld();
  const hwmon = new SimulatedHwmonBackend();
  world.attachHwmon(hwmon);
  hwmon.discover();

  const db = openAndMigrate(config.storage.databasePath);
  const repos = createRepositories(db);
  seedDefaults(repos);

  return {
    dir,
    config,
    repos,
    hwmon,
    world,
    cleanup() {
      try {
        db.close();
      } catch {
        /* déjà fermée */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Amorce une calibration complète (comme le mode démonstration). */
export function calibrateAll(env: TestEnv): void {
  seedDemoCalibration(env.repos, env.hwmon);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend qu'une condition devienne vraie, ou échoue après `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}
