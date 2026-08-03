/** Enregistrement du service worker et gestion des mises à jour.
 *
 *  Deux précautions propres à cette application :
 *
 *   - le service worker n'est **jamais** activé automatiquement quand une
 *     nouvelle version est disponible. Remplacer l'application pendant qu'on
 *     règle une courbe de ventilation ou qu'on mène une calibration serait
 *     inacceptable : c'est l'utilisateur qui déclenche le rechargement ;
 *   - il n'est pas enregistré en développement, où il masquerait le
 *     rechargement à chaud et rendrait le débogage confus.
 */

export type UpdateListener = (apply: () => void) => void;

let waitingWorker: ServiceWorker | null = null;
let listener: UpdateListener | null = null;

/** Prévient l'interface qu'une nouvelle version attend d'être appliquée. */
export function onUpdateAvailable(fn: UpdateListener): void {
  listener = fn;
  if (waitingWorker) fn(applyUpdate);
}

/** Active la version en attente et recharge — appelé par l'utilisateur seul. */
export function applyUpdate(): void {
  if (!waitingWorker) return;
  // `controllerchange` suit l'activation : on recharge à ce moment-là, une
  // seule fois, pour que la page passe sous le nouveau worker.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  }, { once: true });
  waitingWorker.postMessage('pcia:skip-waiting');
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // En développement, `sw.js` n'est pas produit : l'enregistrement échouerait,
  // et un worker actif brouillerait le rechargement à chaud.
  // Même accès typé que le reste du code (cf. services/apiClient.ts) : le projet
  // ne dépend pas des types `vite/client`.
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  if (env?.DEV) return;

  // L'enregistrement est différé jusqu'au chargement complet, pour ne pas
  // concurrencer la première récupération de données. Mais `registerServiceWorker`
  // est appelée depuis un amorçage asynchrone : quand elle s'exécute,
  // l'événement `load` est le plus souvent déjà passé, et s'y abonner ne
  // déclencherait jamais rien.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });

  function start() {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Une version déjà en attente au chargement (onglet précédent fermé).
        if (registration.waiting) {
          waitingWorker = registration.waiting;
          listener?.(applyUpdate);
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // `installed` avec un contrôleur existant = mise à jour prête.
            // Sans contrôleur, c'est la première installation : rien à signaler.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              waitingWorker = installing;
              listener?.(applyUpdate);
            }
          });
        });
      })
      .catch((error) => {
        // L'échec de l'enregistrement ne doit jamais empêcher l'application de
        // fonctionner : la PWA est un confort, la supervision est l'essentiel.
        console.warn('[PCIA] service worker non enregistré', error);
      });
  }
}

/** Désinstalle le service worker et vide ses caches.
 *
 *  Filet de sécurité documenté dans docs/ROLLBACK.md : un service worker
 *  défectueux survit à un redéploiement, il faut pouvoir s'en débarrasser sans
 *  demander à chaque utilisateur de manipuler les outils de développement. */
export async function unregisterServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('pcia-')).map((n) => caches.delete(n)));
  }
}

/** Vrai si l'application est lancée depuis l'écran d'accueil. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true
    // Propriété propre à Safari iOS, absente du type standard.
    || (window.navigator as { standalone?: boolean }).standalone === true
  );
}
