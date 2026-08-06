/** Éditeur de courbe : saisie clavier, saisie numérique, contraintes.
 *
 *  Le glisser tactile ne se teste pas de façon fiable en jsdom (pas de mise en
 *  page réelle, donc pas de `getBoundingClientRect` exploitable) ; il est
 *  vérifié dans un vrai navigateur. Ce qui est couvert ici, c'est tout le reste
 *  — dont les deux modes qui rendent la courbe réglable sans souris.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CurveEditor } from './CurveEditor';
import type { FanCurve } from '../../types';

const BASE_CURVE: FanCurve = [
  { temp: 30, pwm: 20 },
  { temp: 60, pwm: 50 },
  { temp: 85, pwm: 100 },
];

/** Hôte contrôlé : reproduit le comportement réel (la courbe remonte au parent). */
function Host({ onCommit = vi.fn(), disabled = false, initial = BASE_CURVE }: {
  onCommit?: (c: FanCurve) => void;
  disabled?: boolean;
  initial?: FanCurve;
}) {
  const [curve, setCurve] = useState<FanCurve>(initial);
  return (
    <CurveEditor
      curve={curve}
      currentTemp={55}
      currentRpm={900}
      onChange={setCurve}
      onCommit={(c) => { setCurve(c); onCommit(c); }}
      disabled={disabled}
    />
  );
}

const points = () => screen.getAllByRole('button', { name: /^Point \d+ sur \d+/ });

/** Dernière courbe transmise au parent. */
function lastCommit(spy: ReturnType<typeof vi.fn>): FanCurve {
  const { calls } = spy.mock;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as FanCurve;
}

describe('description accessible', () => {
  it('énonce la courbe entière, sans obliger à interpréter le graphique', () => {
    render(<Host />);
    // `group` et non `img` : le graphique contient des points focalisables, et
    // une image ne peut pas avoir de descendants interactifs.
    const chart = screen.getByRole('group', { name: /Courbe de ventilation/ });
    expect(chart).toHaveAccessibleName(/30 °C → 20 %/);
    expect(chart).toHaveAccessibleName(/60 °C → 50 %/);
    expect(chart).toHaveAccessibleName(/85 °C → 100 %/);
    expect(chart).toHaveAccessibleName(/Fonctionnement actuel : 55.0 degrés/);
  });

  it('résume la courbe en texte sous le graphique', () => {
    render(<Host />);
    expect(screen.getByText(/3\/6 points/)).toHaveTextContent('30 °C → 20 % ; 60 °C → 50 % ; 85 °C → 100 %');
  });

  it('décrit chaque point et rappelle les touches disponibles', () => {
    render(<Host />);
    expect(points()[0]).toHaveAccessibleName(
      /Point 1 sur 3 : 30 degrés, 20 pour cent\. Flèches pour déplacer, Maj pour un pas de 5, Suppr pour retirer\./,
    );
  });
});

describe('saisie au clavier', () => {
  it('déplace le point focalisé d’un pas avec les flèches', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    points()[0].focus();
    await user.keyboard('{ArrowUp}');
    expect(onCommit).toHaveBeenCalledWith([
      { temp: 30, pwm: 21 }, { temp: 60, pwm: 50 }, { temp: 85, pwm: 100 },
    ]);
  });

  it('utilise un pas de 5 avec Maj', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    points()[1].focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(onCommit).toHaveBeenCalledWith([
      { temp: 30, pwm: 20 }, { temp: 65, pwm: 50 }, { temp: 85, pwm: 100 },
    ]);
  });

  it('empêche un point de dépasser ses voisins', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} initial={[
      { temp: 30, pwm: 20 }, { temp: 32, pwm: 50 }, { temp: 85, pwm: 100 },
    ]} />);

    // Le deuxième point ne peut pas passer sous le premier + 1 °C.
    points()[1].focus();
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    const committed = lastCommit(onCommit);
    expect(committed[1].temp).toBe(31);
    expect(committed[1].temp).toBeGreaterThan(committed[0].temp);
  });

  it('maintient la croissance de la consigne', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    // Descendre fortement le point du milieu ne doit pas le faire passer sous
    // le point précédent : une courbe décroissante serait refusée par le serveur.
    points()[1].focus();
    for (let i = 0; i < 12; i++) await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    const committed = lastCommit(onCommit);
    expect(committed[1].pwm).toBeGreaterThanOrEqual(committed[0].pwm);
  });

  it('supprime le point focalisé avec Suppr', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    points()[1].focus();
    await user.keyboard('{Delete}');
    expect(onCommit).toHaveBeenCalledWith([{ temp: 30, pwm: 20 }, { temp: 85, pwm: 100 }]);
  });

  it('refuse de descendre sous deux points', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} initial={[{ temp: 30, pwm: 20 }, { temp: 85, pwm: 100 }]} />);

    points()[0].focus();
    await user.keyboard('{Delete}');
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('réglage numérique — seul moyen précis au doigt', () => {
  it('permet de choisir un point puis de saisir ses valeurs', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    const editor = document.querySelector('.curve-point-editor') as HTMLElement;
    await user.selectOptions(within(editor).getByLabelText('Point'), '1');

    const temp = within(editor).getByLabelText('Température');
    await user.clear(temp);
    await user.type(temp, '70');
    // La saisie n'est contrainte qu'à la validation : sinon, taper « 70 » dans
    // un champ affichant 60 passerait par 7 puis 310, tous deux ramenés aux
    // bornes, et il deviendrait impossible d'atteindre la valeur voulue.
    await user.tab();

    const committed = lastCommit(onCommit);
    expect(committed[1].temp).toBe(70);
  });

  it('applique aussi la saisie sur la touche Entrée', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    const editor = document.querySelector('.curve-point-editor') as HTMLElement;
    await user.selectOptions(within(editor).getByLabelText('Point'), '1');
    const pwm = within(editor).getByLabelText('Consigne');
    await user.clear(pwm);
    await user.type(pwm, '75{Enter}');

    const committed = lastCommit(onCommit);
    expect(committed[1].pwm).toBe(75);
  });

  it('contraint tout de même la valeur validée aux bornes de la courbe', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    const editor = document.querySelector('.curve-point-editor') as HTMLElement;
    await user.selectOptions(within(editor).getByLabelText('Point'), '1');
    const temp = within(editor).getByLabelText('Température');
    await user.clear(temp);
    await user.type(temp, '200{Enter}');

    const committed = lastCommit(onCommit);
    // Bornée par le point suivant (85 °C), pas acceptée telle quelle.
    expect(committed[1].temp).toBe(84);
  });

  it('laisse les champs inertes tant qu’aucun point n’est choisi', () => {
    render(<Host />);
    const editor = document.querySelector('.curve-point-editor') as HTMLElement;
    expect(within(editor).getByLabelText('Température')).toBeDisabled();
    expect(within(editor).getByLabelText('Consigne')).toBeDisabled();
  });

  it('ajoute un point sans double-clic, geste impossible au doigt et au clavier', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    await user.click(screen.getByRole('button', { name: 'Ajouter un point' }));
    const committed = lastCommit(onCommit);
    expect(committed).toHaveLength(4);
    // Le point ajouté se place sur la courbe existante : la régulation ne
    // change pas du seul fait d'avoir ajouté un point.
    expect(committed[1].temp).toBeGreaterThan(committed[0].temp);
    expect(committed[1].temp).toBeLessThan(committed[2].temp);
  });

  it('refuse d’aller au-delà de six points, comme le serveur', async () => {
    render(<Host initial={[
      { temp: 20, pwm: 10 }, { temp: 35, pwm: 25 }, { temp: 50, pwm: 40 },
      { temp: 65, pwm: 60 }, { temp: 80, pwm: 80 }, { temp: 95, pwm: 100 },
    ]} />);
    expect(screen.getByRole('button', { name: 'Ajouter un point' })).toBeDisabled();
  });
});

describe('édition refusée', () => {
  it('retire les points du parcours clavier et désactive les commandes', () => {
    render(<Host disabled />);
    expect(screen.getByRole('button', { name: 'Ajouter un point' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Supprimer le point' })).toBeDisabled();
    for (const point of points()) {
      expect(point).toHaveAttribute('tabindex', '-1');
    }
  });

  it('ignore les touches de déplacement', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} disabled />);
    points()[0].focus();
    await user.keyboard('{ArrowUp}');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
