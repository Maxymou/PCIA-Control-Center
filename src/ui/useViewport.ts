/** Accès React aux mesures de viewport calculées par `viewport.ts`. */

import { useEffect, useSyncExternalStore } from 'react';
import {
  currentViewport, startViewportSync, subscribeViewport, syncViewport,
  type ViewportMetrics,
} from './viewport';

const FALLBACK: ViewportMetrics = { appHeight: 0, visualHeight: 0, keyboardOpen: false };

/** Démarre la synchronisation du viewport pour toute la durée de vie de
 *  l'application. À monter **une seule fois**, au plus haut niveau. */
export function useViewportSync(): void {
  useEffect(() => startViewportSync(), []);
}

/** Mesures courantes. `useSyncExternalStore` garantit une référence stable :
 *  aucun rendu superflu tant que les valeurs ne changent pas réellement. */
export function useViewportMetrics(): ViewportMetrics {
  return useSyncExternalStore(
    subscribeViewport,
    () => currentViewport() ?? FALLBACK,
    () => FALLBACK,
  );
}

/** Vrai quand le clavier virtuel occupe une part significative de l'écran. */
export function useKeyboardOpen(): boolean {
  return useViewportMetrics().keyboardOpen;
}

/** Force une resynchronisation — utile à l'ouverture d'une superposition, qui
 *  modifie le défilement du document et peut décaler la fenêtre visible. */
export function resyncViewport(): void {
  syncViewport();
}
