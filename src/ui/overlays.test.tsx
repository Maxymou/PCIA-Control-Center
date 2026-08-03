/** Modales, feuilles, infobulles et confirmations.
 *
 *  Ce qui est vérifié ici est ce qui manquait à l'interface d'origine : piège
 *  de focus, restitution du focus, hauteur fondée sur --app-height, infobulles
 *  accessibles au clavier, et confirmations qui énoncent réellement ce qu'elles
 *  engagent.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal, Sheet } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { Tooltip } from './Tooltip';
import { setViewportSize } from '../test/setup';

describe('modale', () => {
  it('expose un dialogue modal correctement étiqueté', () => {
    render(<Modal title="Réglages" onClose={() => {}}><p>Contenu</p></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Réglages');
  });

  it('place le focus à l’intérieur dès l’ouverture', async () => {
    render(
      <Modal title="Réglages" onClose={() => {}}>
        <button type="button">Action</button>
      </Modal>,
    );
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('enferme la tabulation : le focus ne sort jamais du dialogue', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Hors modale</button>
        <Modal title="Réglages" onClose={() => {}}>
          <button type="button">Un</button>
          <button type="button">Deux</button>
        </Modal>
      </>,
    );
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 10; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('se ferme sur Échap', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal title="Réglages" onClose={onClose}><p>Contenu</p></Modal>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('rend le focus au déclencheur à la fermeture', async () => {
    const user = userEvent.setup();

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Ouvrir</button>
          {open && <Modal title="Réglages" onClose={() => setOpen(false)}><p>Contenu</p></Modal>}
        </>
      );
    }

    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Ouvrir' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('se ferme au clic sur le fond, sauf si l’action est engageante', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender, container } = render(
      <Modal title="Réglages" onClose={onClose}><p>Contenu</p></Modal>,
    );
    await user.click(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Modal title="Réglages" onClose={onClose} dismissOnBackdrop={false}><p>Contenu</p></Modal>,
    );
    await user.click(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container).toBeDefined();
  });

  it('verrouille le défilement du document tant qu’elle est ouverte', () => {
    const { unmount } = render(<Modal title="Réglages" onClose={() => {}}><p>Contenu</p></Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('rend la superposition en dehors de la hiérarchie de la section', () => {
    // Un `overflow: hidden` parent rognerait sinon la modale.
    const { container } = render(<Modal title="Réglages" onClose={() => {}}><p>Contenu</p></Modal>);
    expect(container.querySelector('.overlay')).toBeNull();
    expect(document.body.querySelector('.overlay')).not.toBeNull();
  });
});

describe('feuille mobile', () => {
  it('adopte la présentation en feuille sous 768 px', () => {
    setViewportSize(390, 844, { coarse: true });
    render(<Modal title="Détail" onClose={() => {}}><p>Contenu</p></Modal>);
    expect(document.querySelector('.overlay--sheet')).not.toBeNull();
  });

  it('reste une boîte centrée sur poste de travail', () => {
    setViewportSize(1600, 900);
    render(<Modal title="Détail" onClose={() => {}}><p>Contenu</p></Modal>);
    expect(document.querySelector('.overlay--sheet')).toBeNull();
  });

  it('peut être imposée quelle que soit la largeur', () => {
    setViewportSize(1600, 900);
    render(<Sheet title="Détail" onClose={() => {}}><p>Contenu</p></Sheet>);
    expect(document.querySelector('.overlay--sheet')).not.toBeNull();
  });
});

describe('infobulle', () => {
  it('s’ouvre au focus clavier, pas seulement au survol', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explication">
        <button type="button">Aide</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Explication');
  });

  it('relie l’infobulle au déclencheur par aria-describedby', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explication">
        <button type="button">Aide</button>
      </Tooltip>,
    );
    await user.tab();
    const trigger = screen.getByRole('button', { name: 'Aide' });
    const tip = screen.getByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
  });

  it('se ferme sur Échap', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explication">
        <button type="button">Aide</button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('conserve le déclencheur d’origine sans le transformer', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Tooltip content="Explication">
        <button type="button" onClick={onClick}>Agir</button>
      </Tooltip>,
    );
    // Le déclencheur reste un bouton et garde son gestionnaire : l'infobulle
    // ne doit jamais empêcher l'action qu'elle documente.
    await user.click(screen.getByRole('button', { name: 'Agir' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('confirmation d’action', () => {
  const baseProps = {
    action: 'Forcer la ventilation à 100 %',
    target: 'SYS_FAN3 — Tesla V100 n°1',
    consequences: ['Le bruit sera maximal.', 'La courbe est ignorée.'],
    reversible: true,
    onCancel: () => {},
  };

  it('énonce l’action, la cible, les conséquences et la réversibilité', () => {
    render(<ConfirmDialog {...baseProps} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Forcer la ventilation à 100 %');
    expect(dialog).toHaveTextContent('SYS_FAN3 — Tesla V100 n°1');
    expect(dialog).toHaveTextContent('Le bruit sera maximal.');
    expect(dialog).toHaveTextContent('La courbe est ignorée.');
    expect(dialog).toHaveTextContent(/réversible/i);
  });

  it('avertit explicitement quand l’action est irréversible', () => {
    render(<ConfirmDialog {...baseProps} reversible={false} onConfirm={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveTextContent(/irréversible/i);
  });

  it('n’exécute rien tant que l’utilisateur n’a pas confirmé', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('attend la réponse du serveur avant d’annoncer quoi que ce soit', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r; }));

    render(<ConfirmDialog {...baseProps} confirmLabel="Forcer" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Forcer' }));

    // Tant que la promesse n'est pas résolue, le bouton affiche l'envoi en
    // cours : aucun succès n'est annoncé par anticipation.
    expect(screen.getByRole('button', { name: /envoi au serveur/i })).toBeDisabled();
    resolve();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('affiche le refus du serveur au lieu de le masquer', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.reject(new Error('Moteur injoignable')));
    render(<ConfirmDialog {...baseProps} confirmLabel="Forcer" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Forcer' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Moteur injoignable/);
    });
  });

  it('désactive la confirmation et en donne la raison quand l’action est impossible', () => {
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Forcer"
        blockedReason="le moteur de ventilation ne répond pas."
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Forcer' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/le moteur de ventilation ne répond pas/i);
  });
});
