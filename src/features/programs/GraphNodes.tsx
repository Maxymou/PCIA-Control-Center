import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Connection, Service, ServiceGroup, Severity } from '../../types';
import {
  SERVICE_STATUS_LABELS, SERVICE_STATUS_SEVERITY, SERVICE_TYPE_ICONS, SERVICE_TYPE_LABELS,
} from '../../utils/labels';
import { StatusDot } from '../../components/Common';
import { useUiStore } from '../../store/useUiStore';

// ---------- Nœud service ----------
export interface ServiceNodeData {
  service: Service;
  hasAlert: boolean;
  [key: string]: unknown;
}

export function ServiceNode({ data }: NodeProps) {
  const { service: s, hasAlert } = data as unknown as ServiceNodeData;
  const selected = useUiStore((u) => u.selectedServiceId === s.id);
  const sev: Severity = SERVICE_STATUS_SEVERITY[s.status];
  return (
    <div className={`svc-node ${selected ? 'selected' : ''} ${sev !== 'normal' && sev !== 'unknown' ? `sev-border-${sev}` : ''}`}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--border-strong)' }} />
      <div className="head">
        <span className="icon" aria-hidden>{SERVICE_TYPE_ICONS[s.type]}</span>
        <span className="name" title={s.displayName ?? s.name}>{s.displayName ?? s.name}</span>
        <StatusDot sev={sev} pulse={sev === 'critical'} />
      </div>
      <div className="meta">
        <span>{SERVICE_STATUS_LABELS[s.status]}</span>
        {s.version && <span className="mono">v{s.version}</span>}
        {s.port && <span className="mono">:{s.port}</span>}
        {s.address && <span className="mono">{s.address}</span>}
      </div>
      <div className="foot">
        <span className={`badge ${s.origin === 'manual' ? 'accent' : 'outline'}`}>
          {s.origin === 'manual' ? 'Manuel' : 'Détecté'}
        </span>
        <span className="badge outline">{SERVICE_TYPE_LABELS[s.type]}</span>
        {s.isNew && <span className="badge accent">Nouveau</span>}
        {s.note && (
          <span className="badge outline" title={`Note : ${s.note}`}>
            <span aria-hidden="true">📝</span>
            <span className="sr-only">Contient une note</span>
          </span>
        )}
        {hasAlert && <span className="badge warning">⚠</span>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: 'var(--border-strong)' }} />
    </div>
  );
}

// ---------- Groupe déplié (cadre) ----------
export interface GroupNodeData {
  group: ServiceGroup;
  memberCount: number;
  [key: string]: unknown;
}

export function GroupNode({ data }: NodeProps) {
  const { group } = data as unknown as GroupNodeData;
  const selected = useUiStore((u) => u.selectedGroupId === group.id);
  return (
    <div
      className="group-node"
      style={{ borderColor: selected ? 'var(--accent)' : group.color ?? 'var(--border-strong)' }}
    >
      <div className="g-head" style={{ color: group.color ?? 'var(--text-2)' }}>
        <span>▣ {group.name}</span>
        {group.note && (
        <span title={`Note : ${group.note}`}>
          <span aria-hidden="true">📝</span>
          <span className="sr-only">Contient une note</span>
        </span>
      )}
      </div>
    </div>
  );
}

// ---------- Groupe replié ----------
export interface GroupCollapsedData {
  group: ServiceGroup;
  members: Service[];
  alertCount: number;
  inOut: { in: number; out: number };
  [key: string]: unknown;
}

export function GroupCollapsedNode({ data }: NodeProps) {
  const { group, members, alertCount, inOut } = data as unknown as GroupCollapsedData;
  const selected = useUiStore((u) => u.selectedGroupId === group.id);
  const counts: Record<Severity, number> = { normal: 0, warning: 0, critical: 0, unknown: 0 };
  members.forEach((m) => { counts[SERVICE_STATUS_SEVERITY[m.status]] += 1; });
  return (
    <div className="group-collapsed" style={{ borderColor: selected ? 'var(--accent)' : group.color ?? 'var(--border-strong)' }}>
      <Handle type="target" position={Position.Left} style={{ background: 'var(--border-strong)' }} />
      <div className="spread">
        <strong>▣ {group.name}</strong>
        <span className="badge outline">{members.length} service{members.length > 1 ? 's' : ''}</span>
      </div>
      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        {counts.normal > 0 && <span className="badge normal">{counts.normal} actif{counts.normal > 1 ? 's' : ''}</span>}
        {counts.warning > 0 && <span className="badge warning">{counts.warning} attention</span>}
        {counts.critical > 0 && <span className="badge critical">{counts.critical} critique{counts.critical > 1 ? 's' : ''}</span>}
        {counts.unknown > 0 && <span className="badge">{counts.unknown} autre{counts.unknown > 1 ? 's' : ''}</span>}
      </div>
      <div className="row small muted" style={{ marginTop: 6 }}>
        <span>→ {inOut.in} entrante{inOut.in > 1 ? 's' : ''}</span>
        <span>{inOut.out} sortante{inOut.out > 1 ? 's' : ''} →</span>
        {alertCount > 0 && <span className="badge warning">{alertCount} alerte{alertCount > 1 ? 's' : ''}</span>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: 'var(--border-strong)' }} />
    </div>
  );
}

// ---------- Style des connexions ----------
export function edgeStyleFor(c: Connection): { stroke: string; dash?: string; animated: boolean } {
  switch (c.status) {
    case 'active': return { stroke: 'var(--off)', animated: false };
    case 'degraded': return { stroke: 'var(--warn)', animated: true };
    case 'lost': return { stroke: 'var(--crit)', dash: '6 4', animated: false };
    case 'new': return { stroke: 'var(--accent)', animated: true };
    case 'pending': return { stroke: 'var(--accent)', dash: '3 4', animated: false };
    default: return { stroke: 'var(--border-strong)', dash: '2 5', animated: false };
  }
}
