/** Confirmation d'action.
 *
 *  Toute action dangereuse passe par ce composant, dont la signature impose
 *  d'énoncer quatre choses — c'est le point : on ne peut pas demander une
 *  confirmation sans dire ce qu'elle engage.
 *
 *   `action`       ce qui va être fait ;
 *   `target`       sur quoi ;
 *   `consequences` ce que cela provoque réellement ;
 *   `reversible`   si l'on peut revenir en arrière, et comment.
 *
 *  Le bouton de confirmation reste désactivé et explicité tant que la commande
 *  ne peut pas aboutir (back-end injoignable, capacité absente) : l'interface
 *  n'affiche jamais un succès qu'elle ne peut pas obtenir.
 */

import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  /** Verbe d'action, à l'infinitif : « Forcer la ventilation à 100 % ». */
  action: string;
  /** Élément visé : « SYS_FAN3 — PCIe 1, Tesla V100 n°1 ». Facultatif pour les
   *  actions qui ne portent pas sur un objet identifiable. */
  target?: string;
  /** Conséquences concrètes, une par entrée. */
  consequences: string[];
  /** Réversibilité. `false` déclenche un avertissement explicite. */
  reversible: boolean | string;
  /** Libellé du bouton de confirmation. */
  confirmLabel?: string;
  /** Action destructrice : bouton rouge plein. */
  destructive?: boolean;
  /** Raison bloquant la confirmation ; le bouton reste alors désactivé. */
  blockedReason?: string | null;
  /** Peut renvoyer une promesse : le bouton attend la réponse du serveur. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Contenu additionnel (récapitulatif, champ de saisie…). */
  children?: ReactNode;
}

export function ConfirmDialog({
  action,
  target,
  consequences,
  reversible,
  confirmLabel = 'Confirmer',
  destructive = false,
  blockedReason = null,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy || blockedReason) return;
    setBusy(true);
    setError(null);
    try {
      // On attend réellement la réponse : rien n'est annoncé comme réussi avant
      // que le serveur ne l'ait confirmé.
      await onConfirm();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Modal
      title={action}
      description={target ? `Cible : ${target}` : undefined}
      onClose={busy ? () => {} : onCancel}
      // Une action engageante ne se ferme pas par mégarde d'un clic à côté.
      dismissOnBackdrop={false}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy}>Annuler</button>
          <button
            type="button"
            className={destructive ? 'btn-danger-solid' : 'btn-primary'}
            onClick={() => void confirm()}
            disabled={busy || blockedReason !== null}
            aria-describedby={blockedReason ? 'confirm-blocked' : undefined}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Envoi au serveur…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}

      <div className="confirm__consequences">
        <strong>Conséquences</strong>
        <ul>
          {consequences.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>

      <p className="confirm__reversible">
        {reversible === true && 'Cette action est réversible.'}
        {reversible === false && (
          <strong className="sev-critical">Cette action est irréversible.</strong>
        )}
        {typeof reversible === 'string' && reversible}
      </p>

      {blockedReason && (
        <p className="field-error" id="confirm-blocked" role="status">
          Action indisponible : {blockedReason}
        </p>
      )}

      {error && (
        <p className="field-error" role="alert">
          Le serveur a refusé l’action : {error}
        </p>
      )}
    </Modal>
  );
}
