import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import type { Alert, Connection, Service, ServiceGroup } from '../../types';
import { autoLayout, NODE_H, NODE_W } from './layout';
import { edgeStyleFor } from './GraphNodes';

const GROUP_PAD = 30;
const GROUP_HEAD = 30;

export interface BuildInput {
  services: Service[];              // services visibles
  connections: Connection[];        // connexions visibles
  groups: ServiceGroup[];
  alerts: Alert[];
  positions: Record<string, { x: number; y: number }>;
  selectedConnectionId: string | null;
}

export function buildGraph(input: BuildInput): { nodes: Node[]; edges: Edge[] } {
  const { services, connections, groups, alerts, positions, selectedConnectionId } = input;

  // Positions par défaut : dagre pour les services non encore placés
  const needsAuto = services.some((s) => !positions[s.id] && !s.isNew);
  const auto = needsAuto ? autoLayout(services, connections, groups) : {};

  // Zone dédiée aux nouveaux services non placés
  let newIdx = 0;
  const posOf = (s: Service) => {
    if (positions[s.id]) return positions[s.id];
    if (s.isNew) return { x: 20, y: 20 + newIdx++ * (NODE_H + 16) };
    return auto[s.id] ?? { x: 60, y: 60 };
  };

  const activeAlertKey = new Set(
    alerts.filter((a) => a.active).map((a) => `${a.targetKind}:${a.targetId}`),
  );

  const collapsedGroups = groups.filter((g) => g.collapsed);
  const collapsedMemberToGroup = new Map<string, string>();
  for (const g of collapsedGroups) g.serviceIds.forEach((id) => collapsedMemberToGroup.set(id, g.id));

  const nodes: Node[] = [];

  // Services (hors membres de groupes repliés)
  const visibleServiceNodes = services.filter((s) => !collapsedMemberToGroup.has(s.id));
  for (const s of visibleServiceNodes) {
    const svc = s.isNew && positions[s.id] ? { ...s, isNew: false } : s;
    nodes.push({
      id: s.id,
      type: 'service',
      position: posOf(s),
      data: { service: svc, hasAlert: activeAlertKey.has(`service:${s.id}`) },
      width: NODE_W,
      zIndex: 2,
    });
  }

  // Groupes dépliés : cadre englobant les membres
  for (const g of groups.filter((x) => !x.collapsed)) {
    const members = services.filter((s) => g.serviceIds.includes(s.id));
    if (members.length === 0) continue;
    const pts = members.map((m) => posOf(m));
    const minX = Math.min(...pts.map((p) => p.x)) - GROUP_PAD;
    const minY = Math.min(...pts.map((p) => p.y)) - GROUP_PAD - GROUP_HEAD;
    const maxX = Math.max(...pts.map((p) => p.x)) + NODE_W + GROUP_PAD;
    const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H + GROUP_PAD;
    nodes.push({
      id: g.id,
      type: 'group',
      position: { x: minX, y: minY },
      data: { group: g, memberCount: members.length },
      style: { width: maxX - minX, height: maxY - minY },
      zIndex: 0,
      selectable: true,
      draggable: true,
    });
  }

  // Groupes repliés : un seul nœud
  for (const g of collapsedGroups) {
    const members = services.filter((s) => g.serviceIds.includes(s.id));
    if (members.length === 0) continue;
    const pts = members.map((m) => posOf(m));
    const pos = { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) };
    const memberIds = new Set(members.map((m) => m.id));
    const inC = connections.filter((c) => memberIds.has(c.targetId) && !memberIds.has(c.sourceId)).length;
    const outC = connections.filter((c) => memberIds.has(c.sourceId) && !memberIds.has(c.targetId)).length;
    const alertCount = members.filter((m) => activeAlertKey.has(`service:${m.id}`)).length;
    nodes.push({
      id: g.id,
      type: 'groupCollapsed',
      position: pos,
      data: { group: g, members, alertCount, inOut: { in: inC, out: outC } },
      zIndex: 2,
    });
  }

  // Arêtes (endpoints remappés vers les groupes repliés)
  const mapEnd = (id: string) => collapsedMemberToGroup.get(id) ?? id;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const c of connections) {
    const src = mapEnd(c.sourceId);
    const tgt = mapEnd(c.targetId);
    if (src === tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    const dedupeKey = `${src}→${tgt}`;
    const remapped = src !== c.sourceId || tgt !== c.targetId;
    if (remapped && seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const st = edgeStyleFor(c);
    const isSel = c.id === selectedConnectionId;
    const badges: string[] = [];
    if (c.origin === 'manual') badges.push('M');
    if (c.origin === 'corrected') badges.push('corrigée');
    if (c.status === 'new') badges.push('nouvelle');
    if (c.note) badges.push('📝');

    edges.push({
      id: c.id,
      source: src,
      target: tgt,
      animated: st.animated,
      style: {
        stroke: isSel ? 'var(--accent)' : st.stroke,
        strokeWidth: isSel ? 2.4 : 1.6,
        strokeDasharray: st.dash,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: isSel ? 'var(--accent)' : st.stroke, width: 16, height: 16 },
      label: badges.length ? badges.join(' · ') : undefined,
      labelStyle: { fill: 'var(--text-2)', fontSize: 10 },
      labelBgStyle: { fill: '#14171c', fillOpacity: 0.9 },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      interactionWidth: 14,
    });
  }

  return { nodes, edges };
}
