import { useState } from 'react';
import { useLiveStore } from '../store/useLiveStore';
import { dataService } from '../services/dataService';
import { fmtDateTime } from '../utils/format';
import { StatusDot } from './Common';
import type { Alert } from '../types';

export function AlertsPanel({ onClose, onOpenTarget }: {
  onClose: () => void;
  onOpenTarget: (a: Alert) => void;
}) {
  const alerts = useLiveStore((s) => s.snap.alerts);
  const [showHistory, setShowHistory] = useState(false);
  const now = Date.now();
  const shown = alerts.filter((a) => (showHistory ? true : a.active));

  return (
    <aside className="alerts-drawer" aria-label="Panneau des alertes">
      <header className="spread">
        <div>
          <strong>Alertes</strong>{' '}
          <span className="muted small">{alerts.filter((a) => a.active).length} active(s)</span>
        </div>
        <div className="row">
          <button className="btn-sm" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Actives uniquement' : 'Consulter l’historique'}
          </button>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
      </header>
      <div className="list">
        {shown.length === 0 && <div className="empty-state">Aucune alerte. Tout est calme.</div>}
        {shown.map((a) => {
          const snoozed = a.snoozedUntil && a.snoozedUntil > now;
          return (
            <div key={a.id} className="card alert-card" style={{ opacity: a.active ? 1 : 0.55 }}>
              <div className="row">
                <StatusDot sev={a.level === 'critical' ? 'critical' : 'warning'} pulse={a.level === 'critical' && a.active} />
                <span className={`badge ${a.level === 'critical' ? 'critical' : 'warning'}`}>
                  {a.level === 'critical' ? 'Critique' : 'Attention'}
                </span>
                {a.acknowledged && <span className="badge outline">Acquittée</span>}
                {snoozed && <span className="badge outline">Ignorée temporairement</span>}
                {!a.active && <span className="badge outline">Terminée</span>}
                <span className="muted small mono" style={{ marginLeft: 'auto' }}>{fmtDateTime(a.time)}</span>
              </div>
              <div className="msg">{a.message}</div>
              <div className="small muted">Élément : <b style={{ color: 'var(--text)' }}>{a.targetLabel}</b></div>
              {(a.value || a.threshold) && (
                <div className="small mono">
                  {a.value && <>Valeur : {a.value}</>} {a.threshold && <span className="muted"> · seuil : {a.threshold}</span>}
                </div>
              )}
              {a.recommendation && <div className="small muted">💡 {a.recommendation}</div>}
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn-sm" onClick={() => onOpenTarget(a)}>Ouvrir l’élément</button>
                {!a.acknowledged && a.active && (
                  <button className="btn-sm" onClick={() => dataService.ackAlert(a.id)}>Acquitter</button>
                )}
                {a.active && !snoozed && (
                  <button className="btn-sm" onClick={() => dataService.snoozeAlert(a.id, 15)}>Ignorer 15 min</button>
                )}
                {snoozed && (
                  <button className="btn-sm" onClick={() => dataService.unsnoozeAlert(a.id)}>Réactiver</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
