/** Bandeau de mise à jour de l'application installée.
 *
 *  La nouvelle version n'est jamais appliquée d'elle-même : recharger
 *  l'interface pendant un réglage de courbe ou une calibration ferait perdre le
 *  contexte au pire moment. L'utilisateur décide quand.
 */

import { useEffect, useState } from 'react';
import { onUpdateAvailable } from '../pwa/register';

export function UpdateBanner() {
  const [apply, setApply] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // La fonction est stockée dans un état : `setState` interprète une fonction
    // comme une mise à jour fonctionnelle, d'où l'encapsulation.
    onUpdateAvailable((fn) => setApply(() => fn));
  }, []);

  if (!apply || dismissed) return null;

  return (
    <div className="banner banner--info update-banner" role="status">
      <span aria-hidden="true">⟳</span>
      <div className="banner__body">
        <p className="banner__title">Nouvelle version disponible</p>
        <p style={{ margin: 0 }}>
          Le rechargement interrompt la consultation en cours ; il n’a aucun effet
          sur la ventilation, pilotée par le serveur.
        </p>
      </div>
      <div className="row">
        <button type="button" className="btn-sm btn-primary" onClick={apply}>Recharger</button>
        <button type="button" className="btn-sm btn-ghost" onClick={() => setDismissed(true)}>
          Plus tard
        </button>
      </div>
    </div>
  );
}
