/** Superpositions modales — modale centrée et feuille mobile.
 *
 *  Un seul composant, deux présentations : au-delà de 768 px une boîte centrée,
 *  en dessous une feuille ancrée en bas de l'écran, atteignable au pouce et
 *  peignant la zone de l'indicateur d'accueil.
 *
 *  La hauteur repose sur `--app-height`, jamais sur `100vh` : sur iOS, `100vh`
 *  déborde de l'écran tant que la barre d'URL est visible, et le pied de la
 *  modale — donc ses boutons — devient inatteignable.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useScrollLock } from './useFocusTrap';
import { useIsMobile } from './useBreakpoint';
import { resyncViewport } from './useViewport';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pied fixe : les actions restent visibles quand le corps défile. */
  footer?: ReactNode;
  /** Texte descriptif annoncé avec le titre. */
  description?: string;
  /** Force la présentation : `auto` suit la largeur d'écran. */
  variant?: 'auto' | 'dialog' | 'sheet';
  /** Empêche la fermeture par clic sur le fond (actions engageantes). */
  dismissOnBackdrop?: boolean;
  /** Largeur maximale de la boîte centrée. */
  width?: number;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  description,
  variant = 'auto',
  dismissOnBackdrop = true,
  width,
}: ModalProps) {
  const isMobile = useIsMobile();
  const asSheet = variant === 'sheet' || (variant === 'auto' && isMobile);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(panelRef, true, close);
  useScrollLock(true);

  // L'ouverture d'une superposition bloque le défilement du document, ce qui
  // peut faire varier la fenêtre visible : on redemande une mesure.
  useEffect(() => {
    resyncViewport();
  }, []);

  const overlay = (
    <div
      className={`overlay${asSheet ? ' overlay--sheet' : ''}`}
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        style={width && !asSheet ? { width: `min(${width}px, 100%)` } : undefined}
        tabIndex={-1}
      >
        {asSheet && <div className="sheet-grip" aria-hidden="true" />}

        <div className="modal__header">
          <div>
            <h2 className="modal__title" id={titleId}>{title}</h2>
            {description && (
              <p className="small muted" id={descId} style={{ margin: 'var(--sp-1) 0 0' }}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-ghost btn-icon"
            onClick={close}
            aria-label={`Fermer : ${title}`}
          >
            ✕
          </button>
        </div>

        <div className="modal__body">{children}</div>

        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );

  // Portail : la superposition sort de la hiérarchie de la section, ce qui
  // évite qu'un `overflow: hidden` parent ne la rogne.
  return createPortal(overlay, document.body);
}

/** Feuille mobile explicite — même composant, présentation imposée. */
export function Sheet(props: Omit<ModalProps, 'variant'>) {
  return <Modal {...props} variant="sheet" />;
}
