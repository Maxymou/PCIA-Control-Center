import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    // Les tests de ventilation manipulent des minuteries : on laisse de la marge.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Un seul processus : les tests partagent des répertoires temporaires et
    // des verrous de moteur, la parallélisation créerait de fausses collisions.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
