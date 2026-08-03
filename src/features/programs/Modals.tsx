import { useState } from 'react';
import { Modal } from '../../components/Common';
import { useConfigStore } from '../../store/useConfigStore';
import { useAllConnections, useAllServices, serviceLabel } from '../../store/selectors';
import type { Connection, ConnectionType, Service, ServiceStatus, ServiceType } from '../../types';
import {
  CONN_TYPE_LABELS, SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS,
} from '../../utils/labels';

// ---------- Service manuel (ajout / édition) ----------
export function ServiceModal({ existing, onClose }: { existing?: Service; onClose: () => void }) {
  const addManualService = useConfigStore((s) => s.addManualService);
  const updateManualService = useConfigStore((s) => s.updateManualService);
  const [f, setF] = useState({
    name: existing?.name ?? '',
    displayName: existing?.displayName ?? '',
    type: (existing?.type ?? 'other') as ServiceType,
    status: (existing?.status ?? 'unknown') as ServiceStatus,
    version: existing?.version ?? '',
    address: existing?.address ?? '',
    port: existing?.port?.toString() ?? '',
    note: existing?.note ?? '',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const valid = f.name.trim().length > 0;

  const submit = () => {
    const payload = {
      name: f.name.trim(),
      displayName: f.displayName.trim() || undefined,
      type: f.type,
      status: f.status,
      version: f.version.trim() || undefined,
      address: f.address.trim() || undefined,
      port: f.port ? Number(f.port) : undefined,
      note: f.note.trim() || undefined,
    };
    if (existing) updateManualService(existing.id, payload);
    else addManualService(payload);
    onClose();
  };

  return (
    <Modal title={existing ? 'Modifier le service manuel' : 'Ajouter un service'} onClose={onClose}>
      <div className="col">
        <label className="field">Nom technique *
          <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="ex. prometheus" autoFocus />
        </label>
        <label className="field">Nom d’affichage
          <input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="ex. Prometheus" />
        </label>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>Type
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>État
            <select value={f.status} onChange={(e) => set('status', e.target.value)}>
              {Object.entries(SERVICE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>Version
            <input value={f.version} onChange={(e) => set('version', e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>Adresse
            <input value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="127.0.0.1" />
          </label>
          <label className="field" style={{ width: 90 }}>Port
            <input value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label className="field">Note
          <textarea value={f.note} onChange={(e) => set('note', e.target.value)} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={!valid} onClick={submit}>
            {existing ? 'Enregistrer' : 'Ajouter le service'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Connexion (ajout manuel / édition / correction) ----------
export function ConnectionModal({ existing, correcting, onClose }: {
  existing?: Connection; correcting?: boolean; onClose: () => void;
}) {
  const services = useAllServices();
  const addManualConnection = useConfigStore((s) => s.addManualConnection);
  const updateManualConnection = useConfigStore((s) => s.updateManualConnection);
  const correctConnection = useConfigStore((s) => s.correctConnection);
  const [f, setF] = useState({
    sourceId: existing?.sourceId ?? services[0]?.id ?? '',
    targetId: existing?.targetId ?? services[1]?.id ?? '',
    type: (existing?.type ?? 'http') as ConnectionType,
    port: existing?.port?.toString() ?? '',
    endpoint: existing?.endpoint ?? '',
    note: existing?.note ?? '',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const valid = f.sourceId && f.targetId && f.sourceId !== f.targetId;

  const submit = () => {
    const payload = {
      sourceId: f.sourceId, targetId: f.targetId, type: f.type,
      port: f.port ? Number(f.port) : undefined,
      endpoint: f.endpoint.trim() || undefined,
      note: f.note.trim() || undefined,
    };
    if (existing && correcting) correctConnection(existing.id, payload, existing);
    else if (existing) updateManualConnection(existing.id, payload);
    else addManualConnection({ ...payload, status: 'unknown' });
    onClose();
  };

  const title = existing
    ? (correcting ? 'Corriger la connexion détectée' : 'Modifier la connexion')
    : 'Ajouter une connexion';

  return (
    <Modal title={title} onClose={onClose}>
      <div className="col">
        <div className="row">
          <label className="field" style={{ flex: 1 }}>Service source
            <select value={f.sourceId} onChange={(e) => set('sourceId', e.target.value)}>
              {services.map((s) => <option key={s.id} value={s.id}>{s.displayName ?? s.name}</option>)}
            </select>
          </label>
          <button
            className="btn-icon" style={{ marginTop: 18 }} title="Inverser le sens de la connexion"
            onClick={() => setF((p) => ({ ...p, sourceId: p.targetId, targetId: p.sourceId }))}
          >⇄</button>
          <label className="field" style={{ flex: 1 }}>Service destination
            <select value={f.targetId} onChange={(e) => set('targetId', e.target.value)}>
              {services.map((s) => <option key={s.id} value={s.id}>{s.displayName ?? s.name}</option>)}
            </select>
          </label>
        </div>
        {!valid && <div className="small sev-warning">La source et la destination doivent être deux services différents.</div>}
        <div className="row">
          <label className="field" style={{ flex: 1 }}>Type
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(CONN_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field" style={{ width: 90 }}>Port
            <input value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label className="field">Adresse / endpoint
          <input value={f.endpoint} onChange={(e) => set('endpoint', e.target.value)} placeholder="/api/v1" />
        </label>
        <label className="field">Note
          <textarea value={f.note} onChange={(e) => set('note', e.target.value)} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={!valid} onClick={submit}>
            {existing ? 'Enregistrer' : 'Ajouter la connexion'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Création de groupe ----------
export function GroupModal({ onClose }: { onClose: () => void }) {
  const services = useAllServices();
  const addGroup = useConfigStore((s) => s.addGroup);
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (id: string) => setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Modal title="Créer un groupe" onClose={onClose}>
      <div className="col">
        <label className="field">Nom du groupe *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Supervision" autoFocus />
        </label>
        <div className="small muted">Services à inclure :</div>
        <div className="col" style={{ maxHeight: 220, overflowY: 'auto', gap: 4 }}>
          {services.map((s) => (
            <label key={s.id} className="row small" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} />
              {s.displayName ?? s.name}
            </label>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={!name.trim() || sel.length === 0}
            onClick={() => { addGroup(name.trim(), sel); onClose(); }}>
            Créer le groupe
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Éléments masqués ----------
export function HiddenModal({ onClose }: { onClose: () => void }) {
  const services = useAllServices();
  const connections = useAllConnections();
  const hiddenServices = useConfigStore((s) => s.hiddenServices);
  const hiddenConnections = useConfigStore((s) => s.hiddenConnections);
  const unhideService = useConfigStore((s) => s.unhideService);
  const unhideConnection = useConfigStore((s) => s.unhideConnection);
  const empty = hiddenServices.length === 0 && hiddenConnections.length === 0;
  return (
    <Modal title="Éléments masqués" onClose={onClose}>
      {empty && <div className="empty-state">Aucun élément masqué.</div>}
      {hiddenServices.length > 0 && (
        <>
          <p className="card-title">Services</p>
          <div className="col" style={{ gap: 4 }}>
            {hiddenServices.map((id) => (
              <div key={id} className="spread small">
                <span>{serviceLabel(services, id)}</span>
                <button className="btn-sm" onClick={() => unhideService(id)}>Réafficher</button>
              </div>
            ))}
          </div>
        </>
      )}
      {hiddenConnections.length > 0 && (
        <>
          <p className="card-title" style={{ marginTop: 14 }}>Connexions</p>
          <div className="col" style={{ gap: 4 }}>
            {hiddenConnections.map((id) => {
              const c = connections.find((x) => x.id === id);
              return (
                <div key={id} className="spread small">
                  <span>{c ? `${serviceLabel(services, c.sourceId)} → ${serviceLabel(services, c.targetId)}` : id}</span>
                  <button className="btn-sm" onClick={() => unhideConnection(id)}>Réafficher</button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
