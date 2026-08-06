import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, MiniMap, ReactFlow, ReactFlowProvider, applyNodeChanges,
  useReactFlow, type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import { useConfigStore } from '../../store/useConfigStore';
import { useLiveStore } from '../../store/useLiveStore';
import { useUiStore } from '../../store/useUiStore';
import { useVisibleConnections, useVisibleServices } from '../../store/selectors';
import { buildGraph } from './graphBuild';
import { autoLayout } from './layout';
import { GroupCollapsedNode, GroupNode, ServiceNode } from './GraphNodes';
import { GraphToolbar } from './GraphToolbar';
import { SidePanel } from './SidePanel';
import { ConnectionModal, GroupModal, HiddenModal, ServiceModal } from './Modals';
import { Confirm } from '../../components/Common';
import { ServiceListView } from './ServiceListView';
import { Sheet } from '../../ui/Modal';
import { useIsMobile } from '../../ui/useBreakpoint';

const nodeTypes = { service: ServiceNode, group: GroupNode, groupCollapsed: GroupCollapsedNode };

function ProgramsInner() {
  const rf = useReactFlow();
  const isMobile = useIsMobile();
  // `auto` : la présentation suit la taille de l'écran — liste sous 768 px, où
  // un graphe de nœuds de 210 px de large n'est pas lisible ; graphe au-delà.
  // Dès que l'utilisateur choisit explicitement, son choix est respecté et ne
  // change plus tout seul, y compris en rotation.
  const [viewChoice, setViewChoice] = useState<'auto' | 'graph' | 'list'>('auto');
  const effectiveView: 'graph' | 'list' = viewChoice === 'auto'
    ? (isMobile ? 'list' : 'graph')
    : viewChoice;
  const cfg = useConfigStore();
  const ui = useUiStore();
  const alerts = useLiveStore((s) => s.snap.alerts);
  // Le tableau d'alertes est reconstruit à chaque mesure (toutes les 2 s), mais
  // le graphe ne s'intéresse qu'à l'ensemble des cibles en alerte. On le réduit
  // à une clé stable : sans cela, tout le graphe était reconstruit à chaque tick.
  const alertKey = useMemo(
    () => alerts.filter((a) => a.active).map((a) => `${a.targetKind}:${a.targetId}`).sort().join('|'),
    [alerts],
  );
  const alertsForGraph = useMemo(
    () => alerts.filter((a) => a.active),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alertKey],
  );
  const services = useVisibleServices();
  const serviceIds = useMemo(() => new Set(services.map((s) => s.id)), [services]);
  const connections = useVisibleConnections(serviceIds);
  const groups = useMemo(
    () => cfg.groups
      .map((g) => ({ ...g, serviceIds: g.serviceIds.filter((id) => serviceIds.has(id)) }))
      .filter((g) => g.serviceIds.length > 0),
    [cfg.groups, serviceIds],
  );

  const derived = useMemo(
    () => buildGraph({
      services, connections, groups, alerts: alertsForGraph,
      positions: cfg.layout.positions,
      selectedConnectionId: ui.selectedConnectionId,
    }),
    [services, connections, groups, alertsForGraph, cfg.layout.positions, ui.selectedConnectionId],
  );

  const [nodes, setNodes] = useState<Node[]>(derived.nodes);
  const nodesRef = useRef<Node[]>(derived.nodes);
  nodesRef.current = nodes;
  const draggingIds = useRef<Set<string>>(new Set());
  const lastGroupPos = useRef<Record<string, { x: number; y: number }>>({});

  /** Synchronisation données → nœuds.
   *
   *  Deux choses doivent survivre à chaque reconstruction :
   *   - la position d'un nœud en cours de glissement, sinon il reviendrait sous
   *     le curseur à chaque mesure ;
   *   - les dimensions **mesurées** par React Flow (`measured`). React Flow
   *     masque (`visibility: hidden`) tout nœud qu'il croit non mesuré : en les
   *     écrasant à chaque instantané, on rendait le graphe invisible par
   *     intermittence, et on forçait une remesure complète toutes les deux
   *     secondes sur un flux temps réel. */
  useEffect(() => {
    setNodes((cur) => {
      const curById = new Map(cur.map((n) => [n.id, n]));
      return derived.nodes.map((d) => {
        const c = curById.get(d.id);
        if (!c) return d;
        return {
          ...d,
          position: draggingIds.current.has(d.id) ? c.position : d.position,
          measured: c.measured,
          width: c.width ?? d.width,
          height: c.height ?? d.height,
        };
      });
    });
  }, [derived.nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const relevant = changes.filter((ch) => ch.type === 'position' || ch.type === 'dimensions');
    if (relevant.length) setNodes((nds) => applyNodeChanges(relevant, nds));
  }, []);

  const memberIdsOf = useCallback((groupId: string): string[] => {
    const g = groups.find((x) => x.id === groupId);
    return g ? g.serviceIds : [];
  }, [groups]);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    draggingIds.current.add(node.id);
    if (node.type === 'group' || node.type === 'groupCollapsed') {
      lastGroupPos.current[node.id] = { ...node.position };
      memberIdsOf(node.id).forEach((id) => draggingIds.current.add(id));
    }
  }, [memberIdsOf]);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    if (node.type !== 'group' && node.type !== 'groupCollapsed') return;
    const prev = lastGroupPos.current[node.id] ?? node.position;
    const dx = node.position.x - prev.x;
    const dy = node.position.y - prev.y;
    lastGroupPos.current[node.id] = { ...node.position };
    if (dx === 0 && dy === 0) return;
    const members = new Set(memberIdsOf(node.id));
    setNodes((nds) => nds.map((n) =>
      members.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
    ));
  }, [memberIdsOf]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    // Persistance des positions des nœuds déplacés (services et membres de groupes)
    const toPersist: Record<string, { x: number; y: number }> = {};
    const ids = node.type === 'group' || node.type === 'groupCollapsed'
      ? memberIdsOf(node.id)
      : [node.id];
    if (node.type === 'groupCollapsed') {
      // Les membres invisibles d'un groupe replié suivent le déplacement du nœud
      const prevStored = cfg.layout.positions;
      const start = derived.nodes.find((n) => n.id === node.id)?.position;
      if (start) {
        const dx = node.position.x - start.x;
        const dy = node.position.y - start.y;
        ids.forEach((id) => {
          const p = prevStored[id];
          if (p) toPersist[id] = { x: p.x + dx, y: p.y + dy };
        });
      }
    } else {
      for (const n of nodesRef.current) {
        if (ids.includes(n.id)) toPersist[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
    }
    if (Object.keys(toPersist).length) cfg.setPositions(toPersist, true);
    draggingIds.current.clear();
  }, [cfg, memberIdsOf, derived.nodes]);

  // Sélection
  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === 'service') ui.selectService(node.id);
    else ui.selectGroup(node.id);
  }, [ui]);
  const onEdgeClick = useCallback((_: unknown, edge: Edge) => ui.selectConnection(edge.id), [ui]);

  // Alignement automatique
  const doAutoLayout = useCallback(() => {
    const pos = autoLayout(services, connections, groups);
    cfg.setPositions(pos, true);
    setTimeout(() => rf.fitView({ padding: 0.15 }), 60);
  }, [services, connections, groups, cfg, rf]);

  // À l'affichage du graphe, on cadre sur le contenu : une disposition
  // mémorisée sur un écran large laisserait tous les blocs hors champ sur un
  // écran étroit, donnant une zone vide sans aucune indication.
  useEffect(() => {
    if (effectiveView !== 'graph') return;
    const timer = setTimeout(() => rf.fitView({ padding: 0.15, duration: 0 }), 80);
    return () => clearTimeout(timer);
  }, [effectiveView, rf]);

  const detailSheetOpen = useUiStore((s) => s.detailSheetOpen);
  const hasSelection = Boolean(
    ui.selectedServiceId ?? ui.selectedConnectionId ?? ui.selectedGroupId,
  );

  // Modales & confirmation de suppression
  const [modal, setModal] = useState<null | 'service' | 'connection' | 'group' | 'hidden'>(null);
  const [confirmDel, setConfirmDel] = useState<null | { kind: 'service' | 'connection'; id: string; label: string }>(null);

  // Raccourcis : F ajuster, Suppr retirer, Échap désélectionner
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); rf.fitView({ padding: 0.15 }); }
      else if (e.key === 'Escape') { setModal(null); ui.clearSelection(); }
      else if (e.key === 'Delete') {
        const st = useUiStore.getState();
        const c = useConfigStore.getState();
        if (st.selectedServiceId) {
          const s = c.manualServices.find((x) => x.id === st.selectedServiceId);
          if (s) setConfirmDel({ kind: 'service', id: s.id, label: s.displayName ?? s.name });
        } else if (st.selectedConnectionId) {
          const cx = c.manualConnections.find((x) => x.id === st.selectedConnectionId);
          if (cx) setConfirmDel({ kind: 'connection', id: cx.id, label: 'cette connexion manuelle' });
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [rf, ui]);

  return (
    <div className="programs">
      <GraphToolbar
        onOpen={setModal}
        onAutoLayout={doAutoLayout}
        view={effectiveView}
        onViewChange={setViewChoice}
        graphControlsHidden={effectiveView === 'list'}
      />
      <div className="programs-body">
        {effectiveView === 'list' ? (
          <ServiceListView />
        ) : (
        <div className="graph-wrap">
          <ReactFlow
            nodes={nodes}
            edges={derived.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => ui.clearSelection()}
            onMoveEnd={(_, vp) => cfg.setViewport(vp)}
            defaultViewport={cfg.layout.viewport ?? { x: 0, y: 0, zoom: 0.85 }}
            minZoom={0.25}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
            colorMode="dark"
            style={{ background: 'var(--bg)' }}
          >
            <Background gap={24} size={1.5} color="var(--border)" />
            <MiniMap
              pannable zoomable
              style={{ background: 'var(--bg-raised)' }}
              maskColor="rgba(10, 12, 15, 0.6)"
              nodeColor={() => 'var(--border-strong)'}
            />
          </ReactFlow>
          <div className="graph-legend" aria-hidden>
            <div className="li"><span className="line" style={{ borderColor: 'var(--off)' }} /> Connexion active</div>
            <div className="li"><span className="line" style={{ borderColor: 'var(--warn)' }} /> Dégradée</div>
            <div className="li"><span className="line" style={{ borderColor: 'var(--crit)', borderTopStyle: 'dashed' }} /> Perdue</div>
            <div className="li"><span className="line" style={{ borderColor: 'var(--border-strong)', borderTopStyle: 'dotted' }} /> Inconnue</div>
            <div className="li"><span className="badge outline">M</span> Connexion manuelle</div>
          </div>
          {services.length === 0 && (
            <div className="empty-state" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              Aucun service détecté ou visible. Ajustez les filtres ou ajoutez un service manuellement.
            </div>
          )}

          {/* Commandes de zoom et de recentrage atteignables au pouce. Elles
              doublent les boutons de la barre d'outils, trop petits au doigt et
              parfois hors de portée en haut de l'écran. */}
          {isMobile && (
            <div className="graph-controls">
              <button type="button" aria-label="Zoom avant" onClick={() => rf.zoomIn()}>＋</button>
              <button type="button" aria-label="Zoom arrière" onClick={() => rf.zoomOut()}>－</button>
              <button type="button" aria-label="Ajuster à l’écran" onClick={() => rf.fitView({ padding: 0.15 })}>⤢</button>
            </div>
          )}
        </div>
        )}

        {/* Poste de travail : panneau latéral permanent.
            Mobile : feuille ouverte à la sélection, refermable d'un geste. */}
        {!isMobile && <SidePanel />}
      </div>

      {isMobile && detailSheetOpen && hasSelection && (
        <Sheet title="Détail" onClose={() => ui.setDetailSheetOpen(false)}>
          <SidePanel />
        </Sheet>
      )}

      {modal === 'service' && <ServiceModal onClose={() => setModal(null)} />}
      {modal === 'connection' && <ConnectionModal onClose={() => setModal(null)} />}
      {modal === 'group' && <GroupModal onClose={() => setModal(null)} />}
      {modal === 'hidden' && <HiddenModal onClose={() => setModal(null)} />}
      {confirmDel && (
        <Confirm
          message={`Retirer ${confirmDel.kind === 'service' ? `« ${confirmDel.label} »` : confirmDel.label} de la configuration visuelle ?`}
          confirmLabel="Retirer"
          onConfirm={() => {
            if (confirmDel.kind === 'service') cfg.removeManualService(confirmDel.id);
            else cfg.removeManualConnection(confirmDel.id);
            ui.clearSelection();
            setConfirmDel(null);
          }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

export function ProgramsTab() {
  return (
    <ReactFlowProvider>
      <ProgramsInner />
    </ReactFlowProvider>
  );
}
