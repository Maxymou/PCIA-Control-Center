/** Hauteur de l'application — gestion centralisée du viewport.
 *
 *  Le problème que ce module résout ne se voit que sur iOS, et surtout en PWA
 *  installée depuis l'écran d'accueil :
 *
 *   - `100vh` vaut la hauteur de l'écran **barre d'URL rétractée**. Tant qu'elle
 *     est visible, le bas de la page est hors champ : une navigation basse ou un
 *     bouton de modale y deviennent inatteignables.
 *   - `100dvh` corrige ce point mais **suit le clavier** : à l'ouverture du
 *     clavier, tout le shell se rétracte, la navigation basse remonte au milieu
 *     de l'écran et la mise en page saute.
 *   - Au lancement à froid, Safari annonce pendant quelques centaines de
 *     millisecondes une hauteur qui n'est pas la hauteur finale ; sans
 *     resynchronisation, l'affichage reste faux jusqu'à ce que l'utilisateur
 *     fasse pivoter l'appareil — comportement à proscrire.
 *
 *  D'où deux variables distinctes, écrites ici et nulle part ailleurs :
 *
 *   `--app-height` — hauteur **stable**. Utilisée par html, body, #root, le
 *      shell, les superpositions et les modales. Gérée par un **repère haut**
 *      (high-water mark) : elle ne diminue jamais tant que l'orientation ne
 *      change pas, donc l'ouverture du clavier ne rétracte pas l'interface.
 *
 *   `--vvh` — hauteur **réellement visible**, clavier compris. Réservée aux
 *      écrans qui doivent suivre le clavier (`.app-viewport--keyboard`).
 *
 *  Le repère haut est réinitialisé sur un **vrai** changement d'orientation,
 *  détecté par l'inversion du rapport largeur/hauteur et non par l'événement
 *  `orientationchange` seul, qui se déclenche aussi à contretemps.
 */

/** Écart en dessous duquel une variation de hauteur est considérée comme du
 *  bruit (barres d'outils qui se rétractent, arrondis de zoom). Éviter d'écrire
 *  une variable CSS pour 2 px évite autant de repeints inutiles. */
const NOISE_PX = 2;

/** Au-delà de cette réduction relative, la hauteur visible ne peut plus
 *  s'expliquer par une barre d'outils : c'est le clavier. */
const KEYBOARD_RATIO = 0.75;

/** Salve de resynchronisations après le démarrage à froid et après chaque
 *  rotation, en millisecondes. Couvre les animations de barre d'outils d'iOS
 *  (~300 ms) et la stabilisation tardive de la PWA installée. */
const SETTLE_DELAYS_MS = [0, 60, 150, 300, 600, 1000];

export interface ViewportMetrics {
  /** Hauteur stable retenue pour --app-height. */
  appHeight: number;
  /** Hauteur visible instantanée retenue pour --vvh. */
  visualHeight: number;
  /** Vrai quand la hauteur visible est nettement inférieure à la hauteur stable. */
  keyboardOpen: boolean;
}

type Listener = (metrics: ViewportMetrics) => void;

let started = false;
let highWater = 0;
/** Orientation de référence : `true` si plus large que haut. */
let landscape: boolean | null = null;
let lastApplied: ViewportMetrics | null = null;
const listeners = new Set<Listener>();
const timers: ReturnType<typeof setTimeout>[] = [];
let rafId: number | null = null;

function visualViewport(): VisualViewport | null {
  return typeof window !== 'undefined' ? (window.visualViewport ?? null) : null;
}

/** Hauteur de la fenêtre de disposition, hors clavier. */
function layoutHeight(): number {
  // `documentElement.clientHeight` suit la fenêtre de disposition et ignore le
  // clavier : c'est la meilleure base pour une hauteur stable. `innerHeight`
  // sert de repli sur les navigateurs qui ne l'exposent pas correctement.
  const doc = document.documentElement?.clientHeight ?? 0;
  const inner = window.innerHeight ?? 0;
  return Math.max(doc, inner) || inner || doc;
}

/** Hauteur réellement visible, clavier déduit. */
function visibleHeight(): number {
  const vv = visualViewport();
  if (vv && vv.height > 0) return Math.round(vv.height);
  return layoutHeight();
}

function isLandscape(): boolean {
  return (window.innerWidth ?? 0) > (window.innerHeight ?? 0);
}

/** Applique les variables CSS, en n'écrivant que ce qui change réellement. */
function apply(metrics: ViewportMetrics): void {
  const root = document.documentElement;
  const previous = lastApplied;

  if (!previous || Math.abs(previous.appHeight - metrics.appHeight) >= NOISE_PX) {
    root.style.setProperty('--app-height', `${metrics.appHeight}px`);
  }
  if (!previous || Math.abs(previous.visualHeight - metrics.visualHeight) >= NOISE_PX) {
    root.style.setProperty('--vvh', `${metrics.visualHeight}px`);
  }
  if (!previous || previous.keyboardOpen !== metrics.keyboardOpen) {
    // Permet à la mise en page de réagir sans qu'aucun composant n'ait à
    // écouter lui-même le clavier.
    root.classList.toggle('is-keyboard-open', metrics.keyboardOpen);
  }

  lastApplied = metrics;
  for (const listener of listeners) listener(metrics);
}

/** Mesure et applique. `resetHighWater` force l'abandon du repère précédent. */
export function syncViewport(resetHighWater = false): ViewportMetrics {
  const nowLandscape = isLandscape();
  // Une vraie rotation inverse le rapport largeur/hauteur : c'est le seul
  // signal fiable. `orientationchange` seul se déclenche trop tôt, et parfois
  // sans que les dimensions aient encore changé.
  const rotated = landscape !== null && landscape !== nowLandscape;
  if (rotated || resetHighWater) highWater = 0;
  landscape = nowLandscape;

  const layout = layoutHeight();
  const visible = visibleHeight();

  // Le repère haut ne retient que la hauteur de disposition : le clavier réduit
  // `visible`, jamais `layout`. Retenir le maximum protège en plus des mesures
  // transitoires trop basses au lancement à froid.
  highWater = Math.max(highWater, layout);

  const appHeight = highWater || layout || visible;
  const keyboardOpen = appHeight > 0 && visible > 0 && visible < appHeight * KEYBOARD_RATIO;

  const metrics: ViewportMetrics = {
    appHeight: Math.round(appHeight),
    visualHeight: Math.round(visible),
    keyboardOpen,
  };
  apply(metrics);
  return metrics;
}

/** Enchaîne plusieurs mesures : deux images d'animation puis une salve différée.
 *  Indispensable au lancement à froid et après une rotation, où la première
 *  mesure n'est jamais la bonne. */
function settle(resetHighWater = false): void {
  syncViewport(resetHighWater);

  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    syncViewport(resetHighWater);
    rafId = requestAnimationFrame(() => {
      syncViewport(resetHighWater);
      rafId = null;
    });
  });

  for (const delay of SETTLE_DELAYS_MS) {
    timers.push(setTimeout(() => syncViewport(resetHighWater), delay));
  }
}

let teardown: (() => void) | null = null;

/** Démarre la synchronisation. Idempotent : plusieurs appels ne posent qu'un
 *  seul jeu d'écouteurs. Renvoie la fonction d'arrêt. */
export function startViewportSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (started) return stopViewportSync;
  started = true;

  settle(true);

  const onResize = () => syncViewport();
  // Une rotation change la hauteur de référence : le repère doit repartir de
  // zéro, sinon l'application garderait la hauteur du mode portrait en paysage.
  const onOrientation = () => settle(true);
  // `pageshow` couvre le retour depuis le cache de navigation arrière/avant,
  // fréquent quand l'utilisateur quitte puis revient dans la PWA.
  const onPageShow = () => settle();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') settle();
  };

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onOrientation);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);

  const vv = visualViewport();
  // `scroll` du visualViewport n'est écouté que si le clavier peut décaler la
  // vue : sur poste de travail il ne se déclenche pas, et l'écouter partout
  // provoquerait des mesures inutiles à chaque défilement.
  const onVvResize = () => syncViewport();
  vv?.addEventListener('resize', onVvResize);

  teardown = () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientation);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibility);
    vv?.removeEventListener('resize', onVvResize);
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    started = false;
    teardown = null;
  };

  return stopViewportSync;
}

/** Arrête la synchronisation et retire tous les écouteurs et minuteries. */
export function stopViewportSync(): void {
  teardown?.();
}

/** S'abonne aux mesures (clavier ouvert, hauteurs). Renvoie le désabonnement. */
export function subscribeViewport(listener: Listener): () => void {
  listeners.add(listener);
  if (lastApplied) listener(lastApplied);
  return () => listeners.delete(listener);
}

/** Dernières mesures connues, ou `null` avant le premier calcul. */
export function currentViewport(): ViewportMetrics | null {
  return lastApplied;
}

/** Réinitialise l'état interne — réservé aux tests. */
export function __resetViewportForTests(): void {
  teardown?.();
  started = false;
  highWater = 0;
  landscape = null;
  lastApplied = null;
  listeners.clear();
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
}
