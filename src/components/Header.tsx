import { useActiveAlerts, useGlobalStatus } from '../store/selectors';
import { useLiveStore } from '../store/useLiveStore';
import { SEVERITY_LABELS } from '../utils/labels';
import { fmtTime } from '../utils/format';
import { providerInfo } from '../services/dataService';
import { StatusDot } from './Common';

/** Libellé de la source de données réellement utilisée. */
const SOURCE_LABELS: Record<string, string> = {
  mock: 'simulé',
  demo: 'démonstration',
  hardware: 'matériel',
};

export function Header({ onOpenAlerts }: { onOpenAlerts: () => void }) {
  const status = useGlobalStatus();
  const alerts = useActiveAlerts();
  const time = useLiveStore((s) => s.snap.time);
  const backend = useLiveStore((s) => s.snap.backendConnected);
  const system = useLiveStore((s) => s.snap.system);
  const critical = alerts.filter((a) => a.level === 'critical').length;

  const provider = providerInfo();
  const mode = system?.mode ?? provider.mode;
  const sourceLabel = SOURCE_LABELS[mode] ?? mode;
  const tip = provider.kind === 'mock'
    ? `Aucun back-end joignable : données simulées dans le navigateur.${provider.fallbackReason ? ` (${provider.fallbackReason})` : ''}`
    : mode === 'demo'
      ? 'Back-end en mode démonstration : les mesures sont simulées côté serveur.'
      : `Back-end en mode matériel${system?.degraded ? ' (dégradé)' : ''} — version ${system?.version ?? provider.version ?? '?'}`;

  return (
    <header className="header">
      <div className="brand">
        <div className="logo">P</div>
        <h1>PCIA Control Center</h1>
      </div>
      <div className="sep" />
      <div className="stat">
        <StatusDot sev={status} pulse={status === 'critical'} />
        État général : <b className={`sev-${status}`}>{SEVERITY_LABELS[status]}</b>
      </div>
      <div className="sep" />
      <div className="stat">
        Alertes actives : <b>{alerts.length}</b>
        {critical > 0 && <span className="badge critical">{critical} critique{critical > 1 ? 's' : ''}</span>}
      </div>
      <div className="sep" />
      <div className="stat">Actualisé à <b className="mono">{fmtTime(time)}</b></div>
      <div className="right">
        <span className="backend-pill" data-tip={tip}>
          <StatusDot sev={backend ? (system?.degraded ? 'warning' : 'normal') : 'critical'} />
          Back-end {backend ? 'connecté' : 'déconnecté'} <span className="muted">· {sourceLabel}</span>
        </span>
        {system && !system.fanEngine.online && (
          <span className="badge critical" data-tip="Le moteur de ventilation ne répond plus : vérifier pcia-fan-control.">
            Moteur ventilation hors ligne
          </span>
        )}
        <button onClick={onOpenAlerts}>
          🔔 Alertes{alerts.length > 0 ? ` (${alerts.length})` : ''}
        </button>
      </div>
    </header>
  );
}
