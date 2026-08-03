import { useState } from 'react';
import { useLiveStore } from '../store/useLiveStore';
import { dataService } from '../services/dataService';
import { fmtDateTime } from '../utils/format';
import { StatusDot } from './Common';
import type { Alert } from '../types';

/** Liste d'alertes réutilisable.
 *
 *  Employée à deux endroits : le tiroir latéral ouvert depuis l'en-tête (accès
 *  rapide sans quitter la section courante) et la section « Alertes et
 *  événements ». Un seul rendu, donc un seul comportement à vérifier. */
export function AlertsList({ onOpenTarget }: { onOpenTarget: (a: Alert) => void }) {
  const alerts = useLiveStore((s) => s.snap.alerts);
  const [showHistory, setShowHistory] = useState(false);
  const now = Date.now();
  const shown = alerts.filter((a) => (showHistory ? true : a.active));
  const activeCount = alerts.filter((a) => a.active).length;

  return (
    <>
      <div className="spread row-wrap" style={{ marginBottom: 'var(--sp-2)' }}>
        <p className="small muted" style={{ margin: 0 }}>
          {activeCount} alerte(s) active(s)
        </p>
        <button
          type="button"
          className="btn-sm"
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? 'Actives uniquement' : 'Consulter l’historique'}
        </button>
      </div>

      <ul className="col" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {shown.length === 0 && (
          <li className="empty-state">Aucune alerte. Tout est calme.</li>
        )}
        {shown.map((a) => {
          const snoozed = a.snoozedUntil !== undefined && a.snoozedUntil > now;
          return (
            <li key={a.id} className="card alert-card" style={{ opacity: a.active ? 1 : 0.55 }}>
              <div className="row row-wrap">
                <StatusDot
                  sev={a.level === 'critical' ? 'critical' : 'warning'}
                  pulse={a.level === 'critical' && a.active}
                />
                <span className={`badge ${a.level === 'critical' ? 'critical' : 'warning'}`}>
                  {a.level === 'critical' ? 'Critique' : 'Attention'}
                </span>
                {a.acknowledged && <span className="badge outline">Acquittée</span>}
                {snoozed && <span className="badge outline">Ignorée temporairement</span>}
                {!a.active && <span className="badge outline">Terminée</span>}
                <span className="muted small mono" style={{ marginLeft: 'auto' }}>
                  {fmtDateTime(a.time)}
                </span>
              </div>
              <div className="msg">{a.message}</div>
              <div className="small muted">
                Élément : <b style={{ color: 'var(--text)' }}>{a.targetLabel}</b>
              </div>
              {(a.value || a.threshold) && (
                <div className="small mono">
                  {a.value && <>Valeur : {a.value}</>}
                  {a.threshold && <span className="muted"> · seuil : {a.threshold}</span>}
                </div>
              )}
              {a.recommendation && <div className="small muted">💡 {a.recommendation}</div>}
              <div className="row row-wrap">
                <button type="button" className="btn-sm" onClick={() => onOpenTarget(a)}>
                  Ouvrir l’élément
                </button>
                {!a.acknowledged && a.active && (
                  <button type="button" className="btn-sm" onClick={() => dataService.ackAlert(a.id)}>
                    Acquitter
                  </button>
                )}
                {a.active && !snoozed && (
                  <button type="button" className="btn-sm" onClick={() => dataService.snoozeAlert(a.id, 15)}>
                    Ignorer 15 min
                  </button>
                )}
                {snoozed && (
                  <button type="button" className="btn-sm" onClick={() => dataService.unsnoozeAlert(a.id)}>
                    Réactiver
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Tiroir latéral ouvert depuis l'en-tête, sans quitter la section courante. */
export function AlertsPanel({ onClose, onOpenTarget }: {
  onClose: () => void;
  onOpenTarget: (a: Alert) => void;
}) {
  return (
    <aside className="alerts-drawer" aria-label="Panneau des alertes">
      <header className="spread">
        <strong>Alertes</strong>
        <button
          type="button"
          className="btn-ghost btn-icon"
          onClick={onClose}
          aria-label="Fermer le panneau des alertes"
        >
          ✕
        </button>
      </header>
      <div className="list">
        <AlertsList onOpenTarget={onOpenTarget} />
      </div>
    </aside>
  );
}
