/* eslint-env serviceworker */
/**
 * Service worker de PCIA Control Center.
 *
 * Ce fichier est un **modèle** : le plugin Vite `pciaPwa()` (cf. vite.config.ts)
 * y injecte, à la compilation, la liste des ressources produites et une version
 * dérivée de leur contenu, puis écrit le résultat dans `dist/sw.js`.
 *
 * ---------------------------------------------------------------------------
 * Cette application pilote un serveur réel. Le service worker en tient compte.
 * ---------------------------------------------------------------------------
 *
 * Règle absolue : **aucune requête vers /api/ ou /ws/ n'est interceptée.**
 * Pas de mise en cache, pas de réponse de secours, pas de file d'attente, pas
 * de synchronisation différée. Servir une température vieille de dix minutes
 * comme si elle était actuelle, ou rejouer une consigne de ventilation au
 * retour du réseau, serait dangereux — ce sont précisément les deux choses
 * qu'un service worker « intelligent » ferait spontanément.
 *
 * Le worker ne met en cache que la coquille statique de l'application, dont les
 * noms de fichiers sont hachés par Vite. Une réponse périmée y est donc
 * impossible : un contenu différent porte un nom différent.
 *
 * Politiques :
 *
 *   /api/**, /ws/**            jamais interceptées (le réseau, ou rien)
 *   méthode ≠ GET              jamais interceptées
 *   navigation (document)      réseau d'abord, repli sur la coquille en cache
 *   ressources versionnées     cache d'abord (immuables par construction)
 *   reste                      réseau seul
 */

const VERSION = '__PCIA_SW_VERSION__';
const CACHE_NAME = `pcia-shell-${VERSION}`;

/** Ressources de la coquille, injectées à la compilation. */
const PRECACHE = __PCIA_PRECACHE__;

/** Document servi quand une navigation échoue hors ligne. */
const OFFLINE_URL = '/offline.html';

// =====================================================================
// Installation : préchargement de la coquille
// =====================================================================

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `reload` : on ignore le cache HTTP du navigateur au préchargement, pour
      // ne pas figer une version intermédiaire dans le cache du worker.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      // Pas de skipWaiting automatique : une mise à jour ne doit pas remplacer
      // l'application sous les doigts de quelqu'un en train de régler une
      // courbe de ventilation. C'est l'utilisateur qui déclenche le
      // rechargement, via le bandeau de mise à jour.
    })(),
  );
});

// =====================================================================
// Activation : purge des versions précédentes
// =====================================================================

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('pcia-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// =====================================================================
// Interception
// =====================================================================

/** Vrai pour tout ce qui touche aux données vivantes du serveur. */
function isLiveData(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/');
}

/** Vrai pour une ressource au nom haché par Vite, donc immuable. */
function isVersionedAsset(url) {
  return url.pathname.startsWith('/assets/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Une mutation n'est jamais interceptée, jamais mise en file, jamais rejouée.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Autre origine : on laisse le navigateur faire. L'application ne dépend
  // d'aucune ressource distante, ce cas ne devrait pas se produire.
  if (url.origin !== self.location.origin) return;

  // Données vivantes : le réseau, ou une erreur franche. Jamais de cache.
  if (isLiveData(url)) return;

  // Navigation : réseau d'abord — l'utilisateur doit obtenir la dernière
  // version dès qu'il est en ligne —, coquille en cache sinon.
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Ressources hachées : cache d'abord, elles ne changent jamais à nom égal.
  if (isVersionedAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Icônes et manifest : cache d'abord avec rafraîchissement en arrière-plan.
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Tout le reste : réseau seul.
});

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    // La coquille récupérée est mémorisée pour le prochain démarrage hors ligne.
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    // La coquille en cache démarre l'application ; elle affichera immédiatement
    // son bandeau « liaison perdue » et désactivera les commandes matérielles,
    // puisqu'aucune donnée ne lui parviendra.
    const shell = await cache.match('/index.html');
    if (shell) return shell;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Hors ligne</title>' +
      '<body style="background:#101216;color:#e6e9ed;font-family:system-ui;padding:24px">' +
      '<h1>PCIA Control Center — hors ligne</h1>' +
      '<p>Le serveur est injoignable et aucune version de l’interface n’est en cache.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// =====================================================================
// Messages depuis la page
// =====================================================================

self.addEventListener('message', (event) => {
  // Déclenché uniquement par l'utilisateur, depuis le bandeau de mise à jour.
  if (event.data === 'pcia:skip-waiting') self.skipWaiting();
  if (event.data === 'pcia:version') {
    event.source?.postMessage({ type: 'pcia:version', version: VERSION });
  }
});
