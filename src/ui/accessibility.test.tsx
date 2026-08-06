/** Garanties d'accessibilité vérifiables sans navigateur.
 *
 *  L'audit complet est réalisé par axe-core dans un vrai navigateur (procédure
 *  décrite dans docs/RESPONSIVE.md). Ces tests figent les points qui se
 *  dégraderaient le plus discrètement au fil des modifications.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SideNav } from './Navigation';
import { CurveEditor } from '../features/hardware/CurveEditor';
import type { FanCurve } from '../types';

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('contrastes', () => {
  /** Luminance relative WCAG d'une couleur hexadécimale. */
  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function ratio(a: string, b: string): number {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  }

  const tokens = read('src/styles/tokens.css');
  const token = (name: string) => {
    const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens)?.[1];
    expect(value, `jeton --${name} introuvable`).toBeTruthy();
    return value!;
  };

  it('respecte le seuil AA sur la surface des cartes, y compris pour le texte tertiaire', () => {
    // C'est le cas qui avait échoué à l'audit : les libellés de 11 px des cartes
    // s'affichent sur --surface, pas sur --bg, et le contraste y est plus faible.
    const surface = token('surface');
    expect(ratio(token('text'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('text-2'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('text-3'), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('respecte le seuil AA sur le fond général', () => {
    const bg = token('bg');
    expect(ratio(token('text'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('text-2'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('text-3'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('conserve trois niveaux de hiérarchie réellement distincts', () => {
    // Passer les contrastes en éclaircissant tout jusqu'à l'uniformité ferait
    // disparaître la hiérarchie : ce n'est pas le remède attendu.
    const surface = token('surface');
    expect(ratio(token('text'), surface)).toBeGreaterThan(ratio(token('text-2'), surface));
    expect(ratio(token('text-2'), surface)).toBeGreaterThan(ratio(token('text-3'), surface));
  });

  it('rend les couleurs d’état lisibles sur les cartes', () => {
    const surface = token('surface');
    for (const state of ['ok', 'warn', 'crit', 'off']) {
      expect(ratio(token(state), surface), `--${state}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('l’état n’est jamais porté par la seule couleur', () => {
  const components = read('src/styles/components.css');

  it('différencie les pastilles d’état par leur forme', () => {
    // Une pastille ronde verte et une pastille ronde rouge sont identiques pour
    // qui ne perçoit pas les couleurs : la forme doit varier aussi.
    const dotSection = components.slice(components.indexOf('.dot {'), components.indexOf('.badge {'));
    expect(dotSection).toMatch(/\.dot\.warning[\s\S]*?border-radius: 2px/);
    expect(dotSection).toMatch(/\.dot\.critical[\s\S]*?border-radius: 2px/);
    expect(dotSection).toMatch(/\.dot\.unknown[\s\S]*?border:/);
  });

  it('souligne les valeurs simulées en plus de les colorer', () => {
    expect(components).toMatch(/\.measure--simulated[\s\S]*?text-decoration: underline dotted/);
  });
});

describe('mouvement', () => {
  it('supprime animations et transitions à la demande du système', () => {
    const base = read('src/styles/base.css');
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.001ms/);
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0\.001ms/);
  });

  it('n’anime la pastille critique que si l’utilisateur l’accepte', () => {
    const components = read('src/styles/components.css');
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dot\.pulse\.critical\s*\{\s*animation: none/);
  });
});

describe('cibles tactiles', () => {
  it('porte toutes les commandes à 44 px sur pointeur grossier', () => {
    const tokens = read('src/styles/tokens.css');
    expect(tokens).toMatch(/--touch:\s*44px/);
    expect(tokens).toMatch(/@media \(pointer: coarse\)[\s\S]*?--control-h: var\(--touch\)/);
    expect(tokens).toMatch(/@media \(pointer: coarse\)[\s\S]*?--touch-sm: var\(--touch\)/);
  });

  it('porte les champs à 16 px sur pointeur grossier, contre le zoom forcé d’iOS', () => {
    // C'est ce qui rend inutile le blocage du zoom, et donc ce qui permet de
    // rester conforme à WCAG 1.4.4.
    const components = read('src/styles/components.css');
    expect(components).toMatch(/@media \(pointer: coarse\)[\s\S]*?font-size: 1rem/);
  });
});

describe('hauteurs', () => {
  it('n’emploie 100vh que dans les valeurs de repli centralisées', () => {
    // Toute autre occurrence signalerait une hauteur calculée localement, donc
    // fausse sur iOS.
    for (const file of ['src/styles/layout.css', 'src/styles/components.css']) {
      expect(read(file), file).not.toMatch(/height:\s*100vh/);
      expect(read(file), file).not.toMatch(/height:\s*100dvh/);
    }
  });

  it('fait reposer les superpositions sur --app-height', () => {
    const components = read('src/styles/components.css');
    expect(components).toMatch(/\.overlay \{[\s\S]*?height: var\(--app-height\)/);
  });
});

describe('éléments sémantiques', () => {
  it('emploie de vrais boutons dans la navigation, pas des div cliquables', () => {
    const { container } = render(<SideNav current="overview" onSelect={() => {}} alertCount={0} />);
    expect(container.querySelectorAll('div[role="button"]')).toHaveLength(0);
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('donne un rôle correct au graphique interactif', () => {
    const curve: FanCurve = [{ temp: 30, pwm: 20 }, { temp: 80, pwm: 90 }];
    render(
      <CurveEditor curve={curve} currentTemp={50} currentRpm={800} onChange={() => {}} onCommit={() => {}} />,
    );
    // Un `role="img"` contenant des points focalisables serait un contrôle
    // imbriqué dans une image — signalé comme violation sérieuse.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('group', { name: /Courbe de ventilation/ })).toBeInTheDocument();
  });
});
