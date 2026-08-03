/** Ossature de l'application.
 *
 *  Trois zones seulement : en-tête, corps (navigation + contenu), navigation
 *  basse sur mobile. La hauteur vient de `.app-viewport`, donc de
 *  `--app-height` : rien ici ne mesure l'écran par lui-même.
 */

import type { ReactNode } from 'react';
import { useIsDesktop, useIsMobile } from './useBreakpoint';
import { BottomNav, SideNav } from './Navigation';
import { SECTION_BY_ID, type SectionId } from './sections';

interface AppShellProps {
  header: ReactNode;
  current: SectionId;
  onSelect: (id: SectionId) => void;
  alertCount: number;
  children: ReactNode;
}

export function AppShell({ header, current, onSelect, alertCount, children }: AppShellProps) {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const section = SECTION_BY_ID[current];

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#contenu-principal">Aller au contenu principal</a>

      {header}

      <div className="app-body">
        {!isMobile && (
          <SideNav
            current={current}
            onSelect={onSelect}
            alertCount={alertCount}
            compact={!isDesktop}
          />
        )}

        <main
          id="contenu-principal"
          className="app-main"
          // Le titre de la section change avec la navigation : les technologies
          // d'assistance annoncent alors la nouvelle région.
          aria-label={section.label}
          tabIndex={-1}
        >
          {/* Titre de niveau 1 de la section : la hiérarchie des titres reste
              cohérente d'une section à l'autre, sans saut de niveau. */}
          <h1 className="sr-only">{section.label} — {section.description}</h1>
          {children}
        </main>
      </div>

      {isMobile && (
        <BottomNav current={current} onSelect={onSelect} alertCount={alertCount} />
      )}
    </div>
  );
}
