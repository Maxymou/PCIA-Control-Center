import { defineConfig } from 'vitest/config';

/** Deux suites aux contraintes opposées, donc deux projets distincts.
 *
 *  `server` : configuration d'origine **reprise à l'identique**. Ces tests
 *  manipulent des minuteries, des verrous de moteur et des répertoires
 *  temporaires partagés ; ils doivent continuer à s'exécuter en environnement
 *  Node, dans un seul processus, sans parallélisme. Aucun de leurs réglages
 *  n'est modifié par l'ajout des tests d'interface.
 *
 *  `web` : tests de l'interface, en jsdom, parallélisables.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
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
      },
      {
        test: {
          name: 'web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
