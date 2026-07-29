import { useState } from 'react';
import { useLiveStore } from '../store/useLiveStore';
import { dataService } from '../services/dataService';
import { useAllConnections, useAllServices, serviceLabel } from '../store/selectors';
import { CONN_TYPE_LABELS } from '../utils/labels';
import { Modal } from './Common';

export function ConflictBanner() {
  const conflicts = useLiveStore((s) => s.snap.conflicts);
  const services = useAllServices();
  const connections = useAllConnections();
  const [compare, setCompare] = useState<string | null>(null);

  if (conflicts.length === 0) return null;
  const c = conflicts[0];
  const conn = connections.find((x) => x.id === c.connectionId);
  const lbl = (id: string) => serviceLabel(services, id);

  return (
    <>
      <div className="conflict-banner" role="alert">
        <div className="row">
          <span className="badge warning">Conflit de détection</span>
          <strong className="small">Une nouvelle détection contredit votre correction manuelle</strong>
        </div>
        <div className="small muted">
          Connexion {conn ? `${lbl(conn.sourceId)} → ${lbl(conn.targetId)}` : c.connectionId} :
          la détection propose {lbl(c.detected.sourceId)} → {lbl(c.detected.targetId)}.
        </div>
        <div className="row">
          <button className="btn-primary btn-sm" onClick={() => dataService.resolveConflict(c.connectionId, false)}>
            Conserver ma correction
          </button>
          <button className="btn-sm" onClick={() => dataService.resolveConflict(c.connectionId, true)}>
            Accepter la nouvelle détection
          </button>
          <button className="btn-sm btn-ghost" onClick={() => setCompare(c.connectionId)}>Comparer</button>
        </div>
      </div>
      {compare && conn && (
        <Modal title="Comparaison des informations" onClose={() => setCompare(null)}>
          <div className="kv">
            <dt>—</dt><dd className="row small muted"><b style={{ width: 130 }}>Votre correction</b><b>Nouvelle détection</b></dd>
            <dt>Source</dt><dd className="row small"><span style={{ width: 130 }}>{lbl(conn.sourceId)}</span><span>{lbl(c.detected.sourceId)}</span></dd>
            <dt>Destination</dt><dd className="row small"><span style={{ width: 130 }}>{lbl(conn.targetId)}</span><span>{lbl(c.detected.targetId)}</span></dd>
            <dt>Type</dt><dd className="row small"><span style={{ width: 130 }}>{CONN_TYPE_LABELS[conn.type]}</span><span>{CONN_TYPE_LABELS[c.detected.type]}</span></dd>
            <dt>Port</dt><dd className="row small mono"><span style={{ width: 130 }}>{conn.port ?? '—'}</span><span>{c.detected.port ?? '—'}</span></dd>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn-primary btn-sm" onClick={() => { dataService.resolveConflict(c.connectionId, false); setCompare(null); }}>
              Conserver ma correction
            </button>
            <button className="btn-sm" onClick={() => { dataService.resolveConflict(c.connectionId, true); setCompare(null); }}>
              Accepter la détection
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
