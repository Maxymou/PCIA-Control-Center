/** Provenance des mesures.
 *
 *  La règle protégée ici est la plus importante de l'application : une valeur
 *  simulée, indisponible ou issue d'un capteur absent ne doit jamais prendre
 *  l'apparence d'une mesure réelle.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Measure, ProvenanceBadge } from './Measure';

describe('valeur réelle', () => {
  it('affiche la valeur et son unité', () => {
    render(<Measure value={62.4} unit="°C" digits={1} />);
    expect(screen.getByText('62.4')).toBeInTheDocument();
    expect(screen.getByText('°C')).toBeInTheDocument();
  });

  it('annonce sa nature aux lecteurs d’écran', () => {
    const { container } = render(<Measure value={62} unit="°C" />);
    expect(container.querySelector('.sr-only')).toHaveTextContent('Mesure réelle');
    expect(container.querySelector('.measure--real')).not.toBeNull();
  });
});

describe('valeur simulée', () => {
  it('est distinguée visuellement et annoncée comme simulée', () => {
    const { container } = render(<Measure value={62} unit="°C" provenance="simulated" />);
    // La distinction ne repose pas sur la seule couleur : la classe applique
    // aussi un soulignement pointillé (cf. components.css).
    expect(container.querySelector('.measure--simulated')).not.toBeNull();
    expect(container.querySelector('.sr-only')).toHaveTextContent(/simulée/i);
    expect(container.querySelector('.sr-only')).toHaveTextContent(/ne correspond à aucun matériel/i);
  });

  it('ne se confond jamais avec une mesure réelle', () => {
    const { container: real } = render(<Measure value={62} unit="°C" />);
    const { container: simulated } = render(<Measure value={62} unit="°C" provenance="simulated" />);
    expect(real.querySelector('.measure')?.className)
      .not.toBe(simulated.querySelector('.measure')?.className);
  });
});

describe('valeur absente', () => {
  it('nomme la cause au lieu d’afficher un tiret ambigu', () => {
    render(<Measure value={null} unit="°C" missingAs="missing" />);
    expect(screen.getByText('indisponible')).toBeInTheDocument();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('distingue un capteur absent d’une capacité manquante', () => {
    const { container: absent } = render(<Measure value={undefined} missingAs="absent" />);
    expect(absent).toHaveTextContent('aucun capteur');

    const { container: missing } = render(<Measure value={undefined} missingAs="missing" />);
    expect(missing).toHaveTextContent('indisponible');
  });

  it('distingue une erreur de lecture d’une absence de capteur', () => {
    render(<Measure value={null} missingAs="error" />);
    expect(screen.getByText('erreur de lecture')).toBeInTheDocument();
  });

  it('traite NaN et l’infini comme des valeurs absentes', () => {
    const { container } = render(<Measure value={Number.NaN} unit="°C" />);
    expect(container).toHaveTextContent('indisponible');

    const { container: infinite } = render(<Measure value={Number.POSITIVE_INFINITY} unit="°C" />);
    expect(infinite).toHaveTextContent('indisponible');
  });

  it('affiche bien zéro, qui est une mesure valide', () => {
    // Piège classique : `value || '—'` ferait disparaître un ventilateur arrêté.
    render(<Measure value={0} unit="RPM" />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('badge de provenance', () => {
  it('ne s’affiche pas pour une mesure réelle', () => {
    const { container } = render(<ProvenanceBadge provenance="real" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('signale une simulation', () => {
    render(<ProvenanceBadge provenance="simulated" />);
    expect(screen.getByText('Simulé')).toBeInTheDocument();
  });
});
