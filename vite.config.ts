import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Cible du back-end pendant le développement (`npm run dev`).
 *  En production, le back-end sert lui-même `dist/` : aucun proxy n'intervient. */
const backend = process.env.PCIA_DEV_BACKEND ?? 'http://127.0.0.1:4321';

export default defineConfig({
  plugins: [react()],
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
