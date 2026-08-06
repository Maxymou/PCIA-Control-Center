/** Préparation de l'environnement jsdom pour les tests d'interface.
 *
 *  jsdom n'implémente ni `matchMedia`, ni `visualViewport`, ni
 *  `ResizeObserver` — trois choses dont dépend directement la refonte
 *  responsive. On les fournit ici, de façon **pilotable** : les tests peuvent
 *  simuler un téléphone, l'ouverture du clavier ou une rotation.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// matchMedia
// ---------------------------------------------------------------------------

/** Largeur simulée de la fenêtre, sur laquelle les requêtes média répondent. */
let viewportWidth = 1600;
let viewportHeight = 900;
let coarsePointer = false;

const mediaListeners = new Set<() => void>();

/** Évalue une requête média simple : largeurs, pointeur, survol, mouvement. */
function matches(query: string): boolean {
  const max = /max-width:\s*(\d+)px/.exec(query);
  const min = /min-width:\s*(\d+)px/.exec(query);
  let result = true;
  if (max) result = result && viewportWidth <= Number(max[1]);
  if (min) result = result && viewportWidth >= Number(min[1]);
  if (query.includes('pointer: coarse')) result = result && coarsePointer;
  if (query.includes('hover: hover')) result = result && !coarsePointer;
  if (query.includes('prefers-reduced-motion')) result = false;
  if (query.includes('display-mode: standalone')) result = false;
  return result;
}

window.matchMedia = ((query: string) => {
  const mql = {
    media: query,
    get matches() { return matches(query); },
    onchange: null,
    addEventListener: (_: string, cb: () => void) => { mediaListeners.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { mediaListeners.delete(cb); },
    addListener: (cb: () => void) => { mediaListeners.add(cb); },
    removeListener: (cb: () => void) => { mediaListeners.delete(cb); },
    dispatchEvent: () => true,
  };
  return mql as unknown as MediaQueryList;
}) as typeof window.matchMedia;

/** Simule une taille d'écran et prévient les abonnés, comme le ferait le
 *  navigateur lors d'un redimensionnement. */
export function setViewportSize(width: number, height: number, options: { coarse?: boolean } = {}): void {
  viewportWidth = width;
  viewportHeight = height;
  if (options.coarse !== undefined) coarsePointer = options.coarse;

  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });

  setVisualViewport(width, height);
  for (const listener of mediaListeners) listener();
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------------------
// visualViewport
// ---------------------------------------------------------------------------

const visualViewportListeners = new Map<string, Set<() => void>>();
let vvWidth = viewportWidth;
let vvHeight = viewportHeight;

Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: {
    get width() { return vvWidth; },
    get height() { return vvHeight; },
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: (type: string, cb: () => void) => {
      if (!visualViewportListeners.has(type)) visualViewportListeners.set(type, new Set());
      visualViewportListeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      visualViewportListeners.get(type)?.delete(cb);
    },
  },
});

function setVisualViewport(width: number, height: number): void {
  vvWidth = width;
  vvHeight = height;
}

/** Simule l'ouverture du clavier virtuel : seule la fenêtre **visible** se
 *  réduit, la fenêtre de disposition reste inchangée — exactement ce que fait
 *  iOS, et la raison d'être du repère haut de `--app-height`. */
export function openKeyboard(keyboardHeight: number): void {
  setVisualViewport(vvWidth, viewportHeight - keyboardHeight);
  for (const cb of visualViewportListeners.get('resize') ?? []) cb();
}

export function closeKeyboard(): void {
  setVisualViewport(vvWidth, viewportHeight);
  for (const cb of visualViewportListeners.get('resize') ?? []) cb();
}

/** Simule une rotation : les dimensions s'inversent. */
export function rotate(): void {
  const width = viewportHeight;
  const height = viewportWidth;
  viewportWidth = width;
  viewportHeight = height;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  setVisualViewport(width, height);
  window.dispatchEvent(new Event('orientationchange'));
}

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom n'implémente pas `scrollIntoView`, utilisé par certains composants.
Element.prototype.scrollIntoView = vi.fn();

/** Bascule l'état réseau annoncé par le navigateur. */
export function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

afterEach(() => {
  cleanup();
  setViewportSize(1600, 900, { coarse: false });
  setOnline(true);
  document.documentElement.style.removeProperty('--app-height');
  document.documentElement.style.removeProperty('--vvh');
  document.documentElement.classList.remove('is-keyboard-open');
});

// Valeurs de départ.
setViewportSize(1600, 900, { coarse: false });
setOnline(true);
