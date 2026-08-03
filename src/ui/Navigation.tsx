/** Navigation principale — deux présentations, une seule source de vérité.
 *
 *  Poste de travail et tablette : navigation latérale verticale (déployée à
 *  partir de 1280 px, réduite aux icônes en dessous).
 *  Mobile : barre basse, atteignable au pouce, qui peint elle-même la zone de
 *  l'indicateur d'accueil iOS.
 *
 *  Les deux emploient de vrais `<button>` dans un `<nav>` : rien n'est un `div`
 *  cliquable, la tabulation fonctionne, et l'entrée courante porte
 *  `aria-current="page"`.
 */

import { BOTTOM_NAV_SECTIONS, SECTIONS, type SectionId } from './sections';

interface NavProps {
  current: SectionId;
  onSelect: (id: SectionId) => void;
  /** Nombre d'alertes actives, affiché en pastille sur la section Alertes. */
  alertCount: number;
  /** Libellés masqués (navigation latérale réduite en tablette). */
  compact?: boolean;
}

function countLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Navigation latérale — tablette et poste de travail. */
export function SideNav({ current, onSelect, alertCount, compact = false }: NavProps) {
  return (
    <nav className="app-nav" aria-label="Navigation principale">
      {SECTIONS.map((section) => {
        const active = section.id === current;
        const showCount = section.id === 'alerts' && alertCount > 0;
        return (
          <button
            key={section.id}
            type="button"
            className="app-nav__item"
            aria-current={active ? 'page' : undefined}
            // Le libellé visible peut être abrégé — ou masqué en mode réduit —
            // pour tenir dans la largeur ; le nom accessible, lui, reste
            // toujours complet, jamais remplacé par le seul pictogramme.
            aria-label={compact || section.navLabel ? section.label : undefined}
            title={compact ? section.label : undefined}
            onClick={() => onSelect(section.id)}
          >
            <span className="app-nav__icon" aria-hidden="true">{section.icon}</span>
            <span className="app-nav__label">{section.navLabel ?? section.label}</span>
            {showCount && (
              <span className="app-nav__count">
                {countLabel(alertCount)}
                <span className="sr-only"> alertes actives</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Barre de navigation basse — mobile. */
export function BottomNav({ current, onSelect, alertCount }: NavProps) {
  return (
    <nav className="bottom-nav" aria-label="Navigation principale">
      {BOTTOM_NAV_SECTIONS.map((section) => {
        const active = section.id === current;
        const showCount = section.id === 'alerts' && alertCount > 0;
        return (
          <button
            key={section.id}
            type="button"
            className="bottom-nav__item"
            aria-current={active ? 'page' : undefined}
            // Le libellé visible est abrégé : le nom accessible reste complet.
            aria-label={section.label}
            onClick={() => onSelect(section.id)}
          >
            <span className="bottom-nav__icon" aria-hidden="true">{section.icon}</span>
            <span className="bottom-nav__label">{section.shortLabel}</span>
            {showCount && (
              <span className="bottom-nav__count" aria-hidden="true">{countLabel(alertCount)}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
