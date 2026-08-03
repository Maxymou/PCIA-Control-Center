/** Bandeau d'état de la liaison.
 *
 *  Visible en permanence dès que les données ne sont plus fraîches. Il énonce
 *  trois choses, jamais moins : ce qui se passe, depuis quand les données
 *  affichées datent, et ce que l'utilisateur ne peut plus faire.
 */

import { formatAge, useConnectionState } from './useConnectionState';
import { fmtTime } from '../utils/format';

export function ConnectionBanner() {
  const link = useConnectionState();

  if (link.status === 'live') return null;

  if (link.status === 'simulation') {
    return (
      <div className="banner banner--info" role="status">
        <span aria-hidden="true">🧪</span>
        <div className="banner__body">
          <p className="banner__title">Simulation locale — aucun back-end</p>
          <p style={{ margin: 0 }}>
            Toutes les valeurs affichées sont produites par le moteur de simulation
            du navigateur. Aucune commande n’atteint de matériel réel.
          </p>
        </div>
      </div>
    );
  }

  const critical = link.status === 'offline';

  return (
    <div
      className={`banner ${critical ? 'banner--critical' : 'banner--warning'}`}
      // `alert` interrompt le lecteur d'écran : justifié, l'utilisateur doit
      // savoir immédiatement qu'il pilote sur des données périmées.
      role="alert"
    >
      <span aria-hidden="true">{critical ? '⛔' : '⚠'}</span>
      <div className="banner__body">
        <p className="banner__title">
          {critical ? 'Liaison perdue avec le back-end' : 'Données non actualisées'}
        </p>
        <p style={{ margin: 0 }}>
          Dernières mesures reçues à <b className="mono">{fmtTime(link.lastUpdate)}</b>
          {' '}({formatAge(link.ageMs)}).{' '}
          {critical
            ? 'La reconnexion est tentée automatiquement, à intervalle croissant.'
            : 'Le flux temps réel est interrompu ; une resynchronisation périodique prend le relais.'}
        </p>
        <p style={{ margin: 'var(--sp-1) 0 0' }}>
          <b>Les commandes matérielles sont désactivées.</b> Aucune commande n’est
          mise en attente : rien ne sera envoyé automatiquement au rétablissement
          de la liaison.
        </p>
        {link.lastError && (
          <p className="small muted" style={{ margin: 'var(--sp-1) 0 0' }}>
            Détail : {link.lastError}
          </p>
        )}
      </div>
    </div>
  );
}
