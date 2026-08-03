import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Cible du back-end pendant le développement (`npm run dev`).
 *  En production, le back-end sert lui-même `dist/` : aucun proxy n'intervient. */
const backend = process.env.PCIA_DEV_BACKEND ?? 'http://127.0.0.1:4321';

/**
 * Génération du service worker — sans dépendance supplémentaire.
 *
 * Workbox et vite-plugin-pwa font beaucoup plus que nécessaire ici, et leur
 * comportement par défaut est précisément celui qu'il faut éviter sur cette
 * application : mise en cache opportuniste des réponses réseau et rejeu différé
 * des requêtes. Le besoin réel tient en une trentaine de lignes — injecter la
 * liste des ressources produites et une version dans un modèle écrit à la main
 * (`src/pwa/sw-template.js`), dont la politique de cache est explicite et
 * relisible.
 */
function pciaPwa(): Plugin {
  const templatePath = fileURLToPath(new URL('./src/pwa/sw-template.js', import.meta.url));

  return {
    name: 'pcia-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Coquille de l'application : le document, les ressources hachées émises
      // par Vite, et les fichiers statiques nécessaires au démarrage hors ligne.
      const emitted = Object.keys(bundle)
        .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
        .map((name) => `/${name}`);

      const precache = [
        '/',
        '/index.html',
        '/offline.html',
        '/manifest.webmanifest',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/apple-touch-icon-180.png',
        ...emitted,
      ];

      // La version dérive du contenu réellement précaché : deux compilations
      // identiques produisent le même service worker, et le moindre changement
      // d'une ressource en produit un nouveau. Aucun horodatage, donc aucune
      // mise à jour inutile poussée aux navigateurs.
      const version = createHash('sha256')
        .update(precache.sort().join('\n'))
        .digest('hex')
        .slice(0, 12);

      const source = readFileSync(templatePath, 'utf8')
        .replace('__PCIA_SW_VERSION__', version)
        .replace('__PCIA_PRECACHE__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), pciaPwa()],
  server: {
    port: 5173,
    // Sans back-end lancé, ces routes échouent et l'application bascule
    // automatiquement sur la simulation locale : le dev reste possible seul.
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend, changeOrigin: true, ws: true },
    },
  },
});
