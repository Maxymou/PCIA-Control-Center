import React from 'react';
import type { Severity } from '../types';
import { useConfigStore } from '../store/useConfigStore';
import { Modal as UiModal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/** Pastille d'état. La couleur ne porte jamais seule l'information : la forme
 *  varie aussi selon la gravité (cf. components.css) et un libellé
 *  l'accompagne systématiquement dans l'interface. */
export function StatusDot({ sev, pulse }: { sev: Severity; pulse?: boolean }) {
  const enabled = useConfigStore((s) => s.prefs.pulseAnimations);
  return <span className={`dot ${sev} ${pulse && enabled ? 'pulse' : ''}`} aria-hidden />;
}

/** Modale — délègue à `src/ui/Modal.tsx` (piège de focus, restitution du focus,
 *  hauteur fondée sur --app-height, présentation en feuille sous 768 px).
 *  La signature d'origine est conservée : les appelants existants sont
 *  inchangés. */
export function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return <UiModal title={title} onClose={onClose}>{children}</UiModal>;
}

/** Confirmation simple, conservée pour les appelants historiques.
 *
 *  Les actions touchant au matériel doivent employer directement
 *  `ConfirmDialog`, dont la signature impose d'énoncer les conséquences. */
export function Confirm({ message, onConfirm, onCancel, confirmLabel = 'Confirmer', consequences, reversible = true }: {
  message: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  confirmLabel?: string;
  consequences?: string[];
  reversible?: boolean | string;
}) {
  return (
    <ConfirmDialog
      action={confirmLabel}
      consequences={consequences ?? ['Seule la configuration visuelle locale est modifiée : aucune action n’atteint le matériel ni les services réels.']}
      reversible={reversible}
      confirmLabel={confirmLabel}
      destructive={/supprim|retir/i.test(confirmLabel)}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p style={{ marginTop: 0 }}>{message}</p>
    </ConfirmDialog>
  );
}
