/** Piège de focus pour les superpositions modales.
 *
 *  Trois obligations, souvent oubliées et pourtant nécessaires pour qu'une
 *  modale soit utilisable au clavier :
 *   1. le focus entre dans la superposition à l'ouverture ;
 *   2. la tabulation y reste enfermée tant qu'elle est ouverte ;
 *   3. le focus revient à l'élément déclencheur à la fermeture — sinon
 *      l'utilisateur clavier repart du début du document.
 */

import { useEffect, type RefObject } from 'react';

/** Éléments focalisables, hors ceux explicitement retirés du parcours. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    // `offsetParent === null` élimine les éléments masqués : sans ce filtre, la
    // tabulation semblerait « bloquée » sur un élément invisible.
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus initial : premier élément focalisable, sinon le conteneur lui-même
    // (qui porte tabIndex={-1} et ne dessine pas d'anneau, cf. base.css).
    const initial = focusable(container)[0] ?? container;
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Le focus peut sortir autrement qu'à la tabulation (clic dans l'arrière-
    // plan, focus programmatique) : on le ramène.
    const onFocusIn = (event: FocusEvent) => {
      if (!container.contains(event.target as Node)) {
        (focusable(container)[0] ?? container).focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      // Restitution du focus, si l'élément d'origine existe toujours.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [ref, active, onEscape]);
}

/** Empêche le document de défiler derrière une superposition.
 *
 *  Le compteur est nécessaire : deux superpositions peuvent se superposer
 *  (une confirmation ouverte depuis une modale), et la fermeture de la seconde
 *  ne doit pas rendre le défilement à la première. */
let lockCount = 0;
let savedOverflow = '';

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}
