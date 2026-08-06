/** Infobulle accessible.
 *
 *  Remplace l'ancien mécanisme `[data-tip]:hover::after`, qui présentait trois
 *  défauts rédhibitoires sur cette application :
 *   - le contenu sortait de l'écran dès que le déclencheur était proche d'un
 *     bord (barre d'outils du graphe, colonne de droite) ;
 *   - il n'apparaissait qu'au survol : inaccessible au clavier et au doigt ;
 *   - il n'était pas annoncé par les lecteurs d'écran.
 *
 *  Ici, la position est calculée à l'ouverture puis corrigée pour rester dans
 *  la fenêtre, et l'infobulle s'ouvre au survol, au focus **et** au toucher.
 *
 *  Une infobulle n'est jamais le seul moyen d'accéder à une information : elle
 *  explique, elle ne cache pas de fonction.
 */

import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Marge minimale conservée entre l'infobulle et le bord de la fenêtre. */
const EDGE = 8;
/** Espace entre le déclencheur et l'infobulle. */
const GAP = 8;

interface Position { top: number; left: number; }

export interface TooltipProps {
  /** Contenu de l'infobulle. */
  content: ReactNode;
  /** Déclencheur : un unique élément recevant les gestionnaires. */
  children: ReactElement;
  /** Côté préféré ; bascule automatiquement si la place manque. */
  placement?: 'top' | 'bottom';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;

    const anchor = trigger.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    // Choix du côté : celui demandé, sauf s'il n'y a pas la place.
    const fitsAbove = anchor.top - box.height - GAP >= EDGE;
    const fitsBelow = anchor.bottom + box.height + GAP <= viewportH - EDGE;
    const above = placement === 'top' ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;

    let top = above ? anchor.top - box.height - GAP : anchor.bottom + GAP;
    // Dernier recours (infobulle plus haute que la fenêtre) : on la colle en
    // haut plutôt que de la laisser sortir.
    top = Math.min(Math.max(top, EDGE), Math.max(EDGE, viewportH - box.height - EDGE));

    // Centrage horizontal sur le déclencheur, puis recadrage dans la fenêtre.
    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.min(Math.max(left, EDGE), Math.max(EDGE, viewportW - box.width - EDGE));

    setPosition({ top, left });
  }, [placement]);

  // `useLayoutEffect` : positionner avant la peinture évite que l'infobulle
  // n'apparaisse une image au mauvais endroit.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, content]);

  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Un défilement ou un redimensionnement déplace le déclencheur : plutôt que
    // de suivre en continu, on referme — comportement attendu et sans coût.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const setTriggerRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    // Préserve une éventuelle ref posée par l'appelant sur le même élément.
    const original = (children as { ref?: unknown }).ref;
    if (typeof original === 'function') (original as (n: HTMLElement | null) => void)(node);
    else if (original && typeof original === 'object') {
      (original as { current: HTMLElement | null }).current = node;
    }
  };

  const trigger = {
    ref: setTriggerRef,
    'aria-describedby': open ? id : undefined,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    // Au toucher, il n'y a pas de survol : le contact ouvre l'infobulle. Le
    // gestionnaire de clic éventuel du déclencheur reste appelé.
    onTouchStart: () => setOpen(true),
  };

  return (
    <>
      {/* Le déclencheur reçoit les gestionnaires ; sa nature (bouton, texte)
          reste celle choisie par l'appelant : rien n'est transformé en div. */}
      {cloneElement(children, trigger)}

      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className="tooltip"
          style={{
            top: position?.top ?? -9999,
            left: position?.left ?? -9999,
            // Tant que la position n'est pas calculée, l'infobulle est mesurée
            // hors champ plutôt qu'affichée au mauvais endroit.
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Bouton d'aide autonome — utile quand le déclencheur naturel est une valeur
 *  ou un libellé qu'il ne faut pas rendre focalisable. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <button type="button" className="help-button" aria-label={label}>
        ?
      </button>
    </Tooltip>
  );
}
