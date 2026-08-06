import { useEffect, useState } from 'react';
import { Confirm, StatusDot } from '../../components/Common';
import { useConfigStore } from '../../store/useConfigStore';
import { useUiStore } from '../../store/useUiStore';
import { serviceLabel, useAllConnections, useAllServices } from '../../store/selectors';
import type { Connection, Service } from '../../types';
import {
  CONN_ORIGIN_LABELS, CONN_STATUS_LABELS, CONN_TYPE_LABELS,
  SERVICE_STATUS_LABELS, SERVICE_STATUS_SEVERITY, SERVICE_TYPE_LABELS,
} from '../../utils/labels';
import { fmtDateTime } from '../../utils/format';
import { ConnectionModal, ServiceModal } from './Modals';

/** Couleurs d'accent proposées pour un groupe — issues de la palette de
 *  courbes du design system, pas de valeurs inventées au fil du code. */
const GROUP_COLORS = [
  'var(--chart-1)', 'var(--chart-5)', 'var(--chart-2)',
  'var(--chart-3)', 'var(--chart-6)', 'var(--chart-4)',
];

/** Champ note éditable avec enregistrement à la validation. */
function NoteField({ value, onSave }: { value?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const dirty = draft !== (value ?? '');
  return (
    <label className="field">Notes
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ajouter une note…" />
      {dirty && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-sm" onClick={() => setDraft(value ?? '')}>Annuler</button>
          <button className="btn-sm btn-primary" onClick={() => onSave(draft)}>Enregistrer la note</button>
        </div>
      )}
    </label>
  );
}

// ---------- Détails d'un service ----------
function ServiceDetails({ service }: { service: Service }) {
  const cfg = useConfigStore();
  const ui = useUiStore();
  const connections = useAllConnections();
  const services = useAllServices();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isManual = service.origin === 'manual';
  const sev = SERVICE_STATUS_SEVERITY[service.status];

  const setField = (patch: Partial<Service>) =>
    isManual ? cfg.updateManualService(service.id, patch) : cfg.overrideService(service.id, patch);

  const incoming = connections.filter((c) => c.targetId === service.id && !cfg.hiddenConnections.includes(c.id));
  const outgoing = connections.filter((c) => c.sourceId === service.id && !cfg.hiddenConnections.includes(c.id));

  return (
    <>
      <div className="row">
        <StatusDot sev={sev} pulse={sev === 'critical'} />
        <h2>{service.displayName ?? service.name}</h2>
        <span className={`badge ${isManual ? 'accent' : 'outline'}`} style={{ marginLeft: 'auto' }}>
          {isManual ? 'Ajouté manuellement' : 'Détecté automatiquement'}
        </span>
      </div>

      <section>
        <label className="field">Nom d’affichage
          <input
            defaultValue={service.displayName ?? ''}
            key={service.id + (service.displayName ?? '')}
            placeholder={service.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (service.displayName ?? '')) setField({ displayName: v || undefined });
            }}
          />
        </label>
      </section>

      <section>
        <dl className="kv">
          <dt>Nom technique</dt><dd className="mono">{service.name}</dd>
          <dt>Type</dt><dd>{SERVICE_TYPE_LABELS[service.type]}</dd>
          <dt>État</dt><dd className={`sev-${sev}`}>{SERVICE_STATUS_LABELS[service.status]}</dd>
          <dt>Version</dt><dd className="mono">{service.version ?? '—'}</dd>
          <dt>Processus</dt><dd className="mono">{service.process ?? '—'}</dd>
          <dt>Conteneur</dt><dd className="mono">{service.container ?? '—'}</dd>
          <dt>Adresse</dt><dd className="mono">{service.address ?? '—'}</dd>
          <dt>Port</dt><dd className="mono">{service.port ?? '—'}</dd>
          <dt>Dernier contrôle</dt><dd className="mono">{fmtDateTime(service.lastCheck)}</dd>
        </dl>
      </section>

      <section>
        <NoteField value={service.note} onSave={(v) => setField({ note: v || undefined })} />
      </section>

      {(incoming.length > 0 || outgoing.length > 0) && (
        <section>
          <p className="card-title">Connexions entrantes ({incoming.length})</p>
          {incoming.map((c) => (
            <div key={c.id} className="conn-line" onClick={() => ui.selectConnection(c.id)}
              role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && ui.selectConnection(c.id)}>
              <StatusDot sev={c.status === 'active' ? 'normal' : c.status === 'degraded' ? 'warning' : c.status === 'lost' ? 'critical' : 'unknown'} />
              {serviceLabel(services, c.sourceId)} <span className="muted">→ · {CONN_TYPE_LABELS[c.type]}</span>
            </div>
          ))}
          <p className="card-title" style={{ marginTop: 10 }}>Connexions sortantes ({outgoing.length})</p>
          {outgoing.map((c) => (
            <div key={c.id} className="conn-line" onClick={() => ui.selectConnection(c.id)}
              role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && ui.selectConnection(c.id)}>
              <StatusDot sev={c.status === 'active' ? 'normal' : c.status === 'degraded' ? 'warning' : c.status === 'lost' ? 'critical' : 'unknown'} />
              <span className="muted">→</span> {serviceLabel(services, c.targetId)} <span className="muted">· {CONN_TYPE_LABELS[c.type]}</span>
            </div>
          ))}
        </section>
      )}

      <div className="divider" />
      <div className="col">
        {isManual && <button onClick={() => setEditing(true)}>Modifier ce service</button>}
        <button onClick={() => { cfg.hideService(service.id); ui.clearSelection(); }}>
          Masquer de la vue
        </button>
        {isManual && (
          <button className="btn-danger" onClick={() => setConfirmRemove(true)}>
            Retirer de la configuration
          </button>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Masquer n’affecte que l’affichage ; retirer supprime ce service manuel de la configuration visuelle.
          Aucune désinstallation réelle n’est effectuée depuis cette interface.
        </p>
      </div>

      {editing && <ServiceModal existing={service} onClose={() => setEditing(false)} />}
      {confirmRemove && (
        <Confirm
          message={`Retirer « ${service.displayName ?? service.name} » de la configuration visuelle ? Ses connexions manuelles seront également retirées.`}
          confirmLabel="Retirer"
          onConfirm={() => { cfg.removeManualService(service.id); ui.clearSelection(); }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}

// ---------- Détails d'une connexion ----------
function ConnectionDetails({ conn }: { conn: Connection }) {
  const cfg = useConfigStore();
  const ui = useUiStore();
  const services = useAllServices();
  const [editing, setEditing] = useState<null | 'edit' | 'correct'>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isManual = conn.origin === 'manual';
  const sev = conn.status === 'active' ? 'normal' : conn.status === 'degraded' ? 'warning' : conn.status === 'lost' ? 'critical' : 'unknown';

  return (
    <>
      <div className="row">
        <StatusDot sev={sev} />
        <h2 style={{ fontSize: 14 }}>
          {serviceLabel(services, conn.sourceId)} → {serviceLabel(services, conn.targetId)}
        </h2>
      </div>
      <section>
        <dl className="kv">
          <dt>Type</dt><dd>{CONN_TYPE_LABELS[conn.type]}</dd>
          <dt>Protocole</dt><dd className="mono">{conn.protocol ?? '—'}</dd>
          <dt>Port</dt><dd className="mono">{conn.port ?? '—'}</dd>
          <dt>Endpoint</dt><dd className="mono">{conn.endpoint ?? '—'}</dd>
          <dt>État</dt><dd className={`sev-${sev}`}>{CONN_STATUS_LABELS[conn.status]}</dd>
          <dt>Origine</dt><dd>{CONN_ORIGIN_LABELS[conn.origin]}</dd>
          <dt>Confiance</dt><dd className="mono">{conn.confidence !== undefined ? `${Math.round(conn.confidence * 100)} %` : '—'}</dd>
          <dt>Dernière activité</dt><dd className="mono">{conn.lastActivity ? fmtDateTime(conn.lastActivity) : '—'}</dd>
        </dl>
      </section>
      {conn.origin === 'corrected' && conn.detectedOriginal && (
        <section className="card card-pad" style={{ background: 'var(--bg-raised)' }}>
          <p className="card-title">Détection d’origine</p>
          <div className="small muted">
            {serviceLabel(services, conn.detectedOriginal.sourceId)} → {serviceLabel(services, conn.detectedOriginal.targetId)}
            {' · '}{CONN_TYPE_LABELS[conn.detectedOriginal.type]}
            {conn.detectedOriginal.port ? ` · port ${conn.detectedOriginal.port}` : ''}
          </div>
        </section>
      )}
      <section>
        <NoteField
          value={conn.note}
          onSave={(v) =>
            isManual
              ? cfg.updateManualConnection(conn.id, { note: v || undefined })
              : cfg.correctConnection(conn.id, { note: v || undefined }, conn)}
        />
      </section>
      <div className="divider" />
      <div className="col">
        {isManual
          ? <button onClick={() => setEditing('edit')}>Modifier la connexion</button>
          : <button onClick={() => setEditing('correct')}>Corriger la connexion</button>}
        {conn.origin === 'corrected' && (
          <button onClick={() => cfg.restoreDetected(conn.id)}>Restaurer les informations détectées</button>
        )}
        <button onClick={() => { cfg.hideConnection(conn.id); ui.clearSelection(); }}>Masquer la connexion</button>
        {isManual && (
          <button className="btn-danger" onClick={() => setConfirmRemove(true)}>Supprimer la connexion manuelle</button>
        )}
      </div>
      {editing && (
        <ConnectionModal existing={conn} correcting={editing === 'correct'} onClose={() => setEditing(null)} />
      )}
      {confirmRemove && (
        <Confirm
          message="Supprimer cette connexion manuelle ?"
          confirmLabel="Supprimer"
          onConfirm={() => { cfg.removeManualConnection(conn.id); ui.clearSelection(); }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}

// ---------- Détails d'un groupe ----------
function GroupDetails({ groupId }: { groupId: string }) {
  const cfg = useConfigStore();
  const ui = useUiStore();
  const services = useAllServices();
  const group = cfg.groups.find((g) => g.id === groupId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (!group) return null;
  return (
    <>
      <div className="row">
        <span style={{ color: group.color ?? 'var(--text-2)' }}>▣</span>
        <h2>{group.name}</h2>
        <span className="badge outline" style={{ marginLeft: 'auto' }}>{group.serviceIds.length} services</span>
      </div>
      <section className="col">
        <label className="field">Nom du groupe
          <input key={group.id + group.name} defaultValue={group.name}
            onBlur={(e) => e.target.value.trim() && cfg.updateGroup(group.id, { name: e.target.value.trim() })} />
        </label>
        <label className="field">Couleur d’accent
          <div className="row">
            {GROUP_COLORS.map((c) => (
              <button key={c} className="btn-icon" aria-label={`Couleur ${c}`}
                style={{ background: c, width: 24, height: 24, borderColor: group.color === c ? 'var(--text)' : 'transparent' }}
                onClick={() => cfg.updateGroup(group.id, { color: c })} />
            ))}
          </div>
        </label>
        <NoteField value={group.note} onSave={(v) => cfg.updateGroup(group.id, { note: v || undefined })} />
      </section>
      <section>
        <p className="card-title">Membres</p>
        {group.serviceIds.map((id) => (
          <div key={id} className="spread small" style={{ padding: '3px 0' }}>
            <span>{serviceLabel(services, id)}</span>
            <button className="btn-sm btn-ghost"
              onClick={() => cfg.updateGroup(group.id, { serviceIds: group.serviceIds.filter((x) => x !== id) })}>
              Retirer du groupe
            </button>
          </div>
        ))}
      </section>
      <div className="divider" />
      <div className="col">
        <button onClick={() => cfg.updateGroup(group.id, { collapsed: !group.collapsed })}>
          {group.collapsed ? 'Déplier le groupe' : 'Replier le groupe'}
        </button>
        <button className="btn-danger" onClick={() => setConfirmRemove(true)}>
          Supprimer le groupe (conserve les services)
        </button>
      </div>
      {confirmRemove && (
        <Confirm
          message={`Supprimer le groupe « ${group.name} » ? Les services qu'il contient sont conservés.`}
          confirmLabel="Supprimer le groupe"
          onConfirm={() => { cfg.removeGroup(group.id); ui.clearSelection(); }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}

export function SidePanel() {
  const { selectedServiceId, selectedConnectionId, selectedGroupId } = useUiStore();
  const services = useAllServices();
  const connections = useAllConnections();
  const service = services.find((s) => s.id === selectedServiceId);
  const conn = connections.find((c) => c.id === selectedConnectionId);

  return (
    <aside className="side-panel" aria-label="Détails de l'élément sélectionné">
      {service && <ServiceDetails service={service} />}
      {conn && <ConnectionDetails conn={conn} />}
      {selectedGroupId && <GroupDetails groupId={selectedGroupId} />}
      {!service && !conn && !selectedGroupId && (
        <div className="empty-state">
          Sélectionnez un service, une connexion ou un groupe pour afficher ses détails.
          <br /><br />
          <span className="small">Raccourcis : F ajuster · Ctrl+Z annuler · Suppr retirer · Échap désélectionner</span>
        </div>
      )}
    </aside>
  );
}
