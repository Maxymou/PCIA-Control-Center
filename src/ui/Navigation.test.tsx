/** Navigation responsive.
 *
 *  Vérifie que la structure change réellement avec la taille d'écran, et que
 *  les libellés abrégés ne dégradent jamais le nom accessible.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BottomNav, SideNav } from './Navigation';
import { SECTIONS, BOTTOM_NAV_SECTIONS } from './sections';

describe('navigation latérale', () => {
  it('présente les six sections dans un repère de navigation', () => {
    render(<SideNav current="overview" onSelect={() => {}} alertCount={0} />);
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(within(nav).getAllByRole('button')).toHaveLength(SECTIONS.length);
    expect(SECTIONS).toHaveLength(6);
  });

  it('marque la section courante avec aria-current', () => {
    render(<SideNav current="fans" onSelect={() => {}} alertCount={0} />);
    const current = screen.getByRole('button', { name: 'Ventilation' });
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('conserve un nom accessible complet malgré un libellé abrégé', () => {
    render(<SideNav current="overview" onSelect={() => {}} alertCount={0} />);
    // Le libellé visible est « Services », le nom accessible reste entier.
    expect(screen.getByRole('button', { name: 'Services et connexions' })).toBeInTheDocument();
  });

  it('garde le libellé accessible quand la navigation est réduite aux icônes', () => {
    render(<SideNav current="overview" onSelect={() => {}} alertCount={0} compact />);
    // Le pictogramme n'est jamais le seul porteur de sens.
    for (const section of SECTIONS) {
      expect(screen.getByRole('button', { name: section.label })).toBeInTheDocument();
    }
  });

  it('affiche le nombre d’alertes actives, avec un libellé et pas seulement un chiffre', () => {
    render(<SideNav current="overview" onSelect={() => {}} alertCount={3} />);
    const alerts = screen.getByRole('button', { name: /Alertes et événements/ });
    expect(alerts).toHaveTextContent('3');
    expect(alerts).toHaveTextContent(/alertes actives/i);
  });

  it('plafonne l’affichage du compteur', () => {
    render(<SideNav current="overview" onSelect={() => {}} alertCount={250} />);
    expect(screen.getByRole('button', { name: /Alertes et événements/ })).toHaveTextContent('99+');
  });

  it('appelle la sélection au clic', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SideNav current="overview" onSelect={onSelect} alertCount={0} />);
    await user.click(screen.getByRole('button', { name: 'Matériel' }));
    expect(onSelect).toHaveBeenCalledWith('hardware');
  });

  it('est entièrement parcourable au clavier', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SideNav current="overview" onSelect={onSelect} alertCount={0} />);
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('hardware');
  });
});

describe('navigation basse', () => {
  it('présente cinq entrées atteignables au pouce', () => {
    render(<BottomNav current="overview" onSelect={() => {}} alertCount={0} />);
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(within(nav).getAllByRole('button')).toHaveLength(BOTTOM_NAV_SECTIONS.length);
    expect(BOTTOM_NAV_SECTIONS).toHaveLength(5);
  });

  it('conserve le nom accessible complet malgré le libellé court', () => {
    render(<BottomNav current="overview" onSelect={() => {}} alertCount={0} />);
    // « Ventil. » à l'écran, « Ventilation » pour un lecteur d'écran.
    expect(screen.getByRole('button', { name: 'Ventilation' })).toHaveTextContent('Ventil.');
  });

  it('marque la section courante', () => {
    render(<BottomNav current="alerts" onSelect={() => {}} alertCount={2} />);
    expect(screen.getByRole('button', { name: 'Alertes et événements' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('laisse Paramètres hors de la barre basse, mais accessible ailleurs', () => {
    render(<BottomNav current="overview" onSelect={() => {}} alertCount={0} />);
    expect(screen.queryByRole('button', { name: 'Paramètres' })).toBeNull();
    // La section existe bien : elle est atteignable par la navigation latérale
    // et depuis la Vue d'ensemble.
    expect(SECTIONS.some((s) => s.id === 'settings')).toBe(true);
  });
});
