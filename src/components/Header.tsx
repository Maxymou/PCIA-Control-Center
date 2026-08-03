import { useActiveAlerts, useGlobalStatus } from '../store/selectors';
import { useLiveStore } from '../store/useLiveStore';
import { SEVERITY_LABELS } from '../utils/labels';
import { fmtTime } from '../utils/format';
import { providerInfo } from '../services/dataService';
import { StatusDot } from './Common';
import { formatAge, useConnectionState } from '../ui/useConnectionState';

/** Libellé de la source de données réellement utilisée. */
const SOURCE_LABELS: Record<string, string> = {
  mock: 'simulé',
  demo: 'démonstration',
  hardware: 'matériel',
};

/** En-tête : identité, état global, source des données, accès aux alertes.
 *
 *  Les indicateurs secondaires (état général détaillé, nombre d'alertes,
 *  horodatage) sont masqués sous 1100 px : ils sont repris sans perte par la
 *  Vue d'ensemble et par la section Alertes, tandis que l'état de connexion et
 *  le bouton d'alertes — les deux seules informations que l'utilisateur doit
 *  pouvoir consulter depuis n'importe quelle section — restent toujours
 *  visibles. */
export function Header({ onOpenAlerts }: { onOpenAlerts: () => void }) {
  const status = useGlobalStatus();
  const alerts = useActiveAlerts();
  const time = useLiveStore((s) => s.snap.time);
  const system = useLiveStore((s) => s.snap.system);
  const critical = alerts.filter((a) => a.level === 'critical').length;
  // Même source que le bandeau d'état : l'en-tête ne peut pas annoncer une
  // liaison saine pendant que le bandeau signale une coupure.
  const link = useConnectionState();

  const provider = providerInfo();
  const mode = system?.mode ?? provider.mode;
  const sourceLabel = SOURCE_LABELS[mode] ?? mode;
  const sourceTitle = provider.kind === 'mock'
    ? `Aucun back-end joignable : données simulées dans le navigateur.${provider.fallbackReason ? ` (${provider.fallbackReason})` : ''}`
    : link.status !== 'live'
      ? `Dernières mesures reçues ${formatAge(link.ageMs)}. Les commandes matérielles sont désactivées.`
      : mode === 'demo'
        ? 'Back-end en mode démonstration : les mesures sont simulées côté serveur.'
        : `Back-end en mode matériel${system?.degraded ? ' (dégradé)' : ''} — version ${system?.version ?? provider.version ?? '?'}`;

  /** Libellé et gravité de la pastille de liaison, alignés sur l'état réel. */
  const LINK_LABEL = {
    live: 'Back-end connecté',
    stale: 'Données non actualisées',
    offline: 'Back-end déconnecté',
    simulation: 'Simulation locale',
  } as const;
  const linkSeverity = link.status === 'live'
    ? (system?.degraded ? 'warning' : 'normal')
    : link.status === 'stale' ? 'warning'
      : link.status === 'simulation' ? 'unknown'
        : 'critical';

  return (
    <header className="header">
      {/* Nom de l'application : repère visuel, pas le titre de la page. Le
          titre de niveau 1 appartient à la section affichée (cf. AppShell). */}
      <div className="brand">
        <div className="logo" aria-hidden="true">P</div>
        <p className="brand__name">PCIA Control Center</p>
      </div>

      <div className="sep" aria-hidden="true" />
      <div className="stat stat--secondary">
        <StatusDot sev={status} pulse={status === 'critical'} />
        État général : <b className={`sev-${status}`}>{SEVERITY_LABELS[status]}</b>
      </div>

      <div className="sep" aria-hidden="true" />
      <div className="stat stat--secondary">
        Alertes actives : <b>{alerts.length}</b>
        {critical > 0 && (
          <span className="badge critical">{critical} critique{critical > 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="sep" aria-hidden="true" />
      <div className="stat stat--secondary">
        Actualisé à <b className="mono">{fmtTime(time)}</b>
      </div>

      <div className="right">
        {system && !system.fanEngine.online && (
          <span
            className="badge critical stat--secondary"
            title="Le moteur de ventilation ne répond plus : vérifier pcia-fan-control."
          >
            Moteur ventilation hors ligne
          </span>
        )}

        <span className="backend-pill" title={sourceTitle}>
          <StatusDot sev={linkSeverity} />
          <span className="backend-pill__text">{LINK_LABEL[link.status]}</span>
          <span className="muted backend-pill__mode">· {sourceLabel}</span>
        </span>

        <button
          type="button"
          onClick={onOpenAlerts}
          aria-label={`Ouvrir le panneau des alertes${alerts.length > 0 ? ` (${alerts.length} active(s))` : ''}`}
        >
          <span aria-hidden="true">🔔</span>
          <span className="header__alerts-label">
            Alertes{alerts.length > 0 ? ` (${alerts.length})` : ''}
          </span>
        </button>
      </div>
    </header>
  );
}
