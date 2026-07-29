import dagre from '@dagrejs/dagre';
import type { Connection, Service, ServiceGroup } from '../../types';

export const NODE_W = 210;
export const NODE_H = 96;

/** Calcule des positions gauche → droite en limitant les croisements.
 *  Les services d'un même groupe sont rapprochés via des contraintes de rang souple
 *  (dagre gère le regroupement par clusters de manière limitée : on aligne
 *  simplement les membres en les reliant au même sous-graphe). */
export function autoLayout(
  services: Service[],
  connections: Connection[],
  groups: ServiceGroup[],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: 'LR', nodesep: 46, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const s of services) g.setNode(s.id, { width: NODE_W, height: NODE_H });

  // Groupes : clusters dagre pour rapprocher les membres
  for (const grp of groups) {
    const members = grp.serviceIds.filter((id) => services.some((s) => s.id === id));
    if (members.length < 2) continue;
    g.setNode(grp.id, {});
    for (const m of members) g.setParent(m, grp.id);
  }

  for (const c of connections) {
    if (g.hasNode(c.sourceId) && g.hasNode(c.targetId)) g.setEdge(c.sourceId, c.targetId);
  }

  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  for (const s of services) {
    const n = g.node(s.id);
    if (n) out[s.id] = { x: Math.round(n.x - NODE_W / 2), y: Math.round(n.y - NODE_H / 2) };
  }
  return out;
}
