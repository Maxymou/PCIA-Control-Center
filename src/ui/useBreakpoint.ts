/** Points de rupture et capacités du pointeur.
 *
 *  Les seuils sont identiques à ceux de `src/styles/layout.css` — toute
 *  modification se fait aux deux endroits.
 *
 *  La largeur décide de la **structure** (une ou plusieurs colonnes, navigation
 *  basse ou latérale) ; la nature du pointeur décide de l'**ergonomie** (taille
 *  des cibles, survol utilisable ou non). Un écran tactile de 1920 px reste un
 *  écran tactile : les deux notions ne se confondent jamais.
 */

import { useSyncExternalStore } from 'react';

export const BREAKPOINTS = {
  /** En dessous : une colonne, navigation basse, panneaux en feuilles. */
  tablet: 768,
  /** À partir de : vue dense, navigation latérale déployée. */
  desktop: 1280,
} as const;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const QUERIES = {
  mobile: `(max-width: ${BREAKPOINTS.tablet - 1}px)`,
  tablet: `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`,
  desktop: `(min-width: ${BREAKPOINTS.desktop}px)`,
  coarse: '(pointer: coarse)',
  hover: '(hover: hover)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;

/** Une `MediaQueryList` par requête, partagée par tous les composants : sans ce
 *  cache, chaque montage créerait son propre écouteur natif. */
const lists = new Map<string, MediaQueryList>();

function list(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let mql = lists.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    lists.set(query, mql);
  }
  return mql;
}

/** S'abonne à une requête média. Le retour est stable, donc utilisable
 *  directement avec `useSyncExternalStore` sans provoquer de boucle. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = list(query);
      if (!mql) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => list(query)?.matches ?? false,
    // Rendu côté serveur ou environnement sans matchMedia : on suppose le cas
    // le plus contraint (mobile), jamais l'inverse.
    () => query === QUERIES.mobile,
  );
}

/** Point de rupture courant. */
export function useBreakpoint(): Breakpoint {
  const isMobile = useMediaQuery(QUERIES.mobile);
  const isDesktop = useMediaQuery(QUERIES.desktop);
  if (isMobile) return 'mobile';
  return isDesktop ? 'desktop' : 'tablet';
}

/** Vrai sous 768 px : une seule colonne, navigation basse, feuilles mobiles. */
export function useIsMobile(): boolean {
  return useMediaQuery(QUERIES.mobile);
}

/** Vrai à partir de 1280 px : vue dense, panneaux latéraux persistants. */
export function useIsDesktop(): boolean {
  return useMediaQuery(QUERIES.desktop);
}

/** Pointeur grossier (doigt, stylet) : cibles agrandies, pas de survol seul. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery(QUERIES.coarse);
}

/** Survol réellement disponible — conditionne les aides au survol, jamais une
 *  action : aucune fonction ne doit être accessible uniquement au survol. */
export function useHasHover(): boolean {
  return useMediaQuery(QUERIES.hover);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(QUERIES.reducedMotion);
}

/** Vide le cache des requêtes — réservé aux tests. */
export function __resetMediaQueryCache(): void {
  lists.clear();
}
