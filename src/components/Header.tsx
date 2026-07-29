import { useActiveAlerts, useGlobalStatus } from '../store/selectors';
import { useLiveStore } from '../store/useLiveStore';
import { SEVERITY_LABELS } from '../utils/labels';
import { fmtTime } from '../utils/format';
import { StatusDot } from './Common';

export function Header({ onOpenAlerts }: { onOpenAlerts: () => void }) {
  const status = useGlobalStatus();
  const alerts = useActiveAlerts();
  const time = useLiveStore((s) => s.snap.time);
  const backend = useLiveStore((s) => s.snap.backendConnected);
  const critical = alerts.filter((a) => a.level === 'critical').length;

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
        <span className="backend-pill" data-tip="Connexion au futur back-end (actuellement simulée)">
          <StatusDot sev={backend ? 'normal' : 'critical'} />
          Back-end {backend ? 'connecté' : 'déconnecté'} <span className="muted">· simulé</span>
        </span>
        <button onClick={onOpenAlerts}>
          🔔 Alertes{alerts.length > 0 ? ` (${alerts.length})` : ''}
        </button>
      </div>
    </header>
  );
}
