import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useConfigStore } from '../../store/useConfigStore';
import { SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS } from '../../utils/labels';

export function GraphToolbar({ onOpen, onAutoLayout }: {
  onOpen: (m: 'service' | 'connection' | 'group' | 'hidden') => void;
  onAutoLayout: () => void;
}) {
  const rf = useReactFlow();
  const cfg = useConfigStore();
  const [filterOpen, setFilterOpen] = useState(false);
  const filterCount = cfg.filters.statuses.length + cfg.filters.types.length;

  const toggle = (key: 'statuses' | 'types', v: string) => {
    const cur = cfg.filters[key];
    cfg.setFilters({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };

  return (
    <div className="graph-toolbar">
      <div className="group">
        <button className="btn-primary btn-sm" onClick={() => onOpen('service')}>+ Service</button>
        <button className="btn-sm" onClick={() => onOpen('connection')}>+ Connexion</button>
        <button className="btn-sm" onClick={() => onOpen('group')}>+ Groupe</button>
      </div>
      <div className="sep" />
      <div className="group">
        <button className="btn-sm" onClick={onAutoLayout} data-tip="Flux organisés de gauche à droite">
          Organiser automatiquement
        </button>
        <button className="btn-sm btn-icon" data-tip="Ajuster à l’écran (F)" onClick={() => rf.fitView({ padding: 0.15 })}>⤢</button>
        <button className="btn-sm btn-icon" data-tip="Centrer la vue" onClick={() => rf.setViewport({ x: 0, y: 0, zoom: 1 })}>⌖</button>
        <button className="btn-sm btn-icon" data-tip="Zoom avant" onClick={() => rf.zoomIn()}>＋</button>
        <button className="btn-sm btn-icon" data-tip="Zoom arrière" onClick={() => rf.zoomOut()}>－</button>
      </div>
      <div className="sep" />
      <div className="group">
        <button className="btn-sm btn-icon" data-tip="Annuler (Ctrl+Z)" onClick={cfg.undo} disabled={cfg.undoStack.length === 0}>↶</button>
        <button className="btn-sm btn-icon" data-tip="Rétablir (Ctrl+Y)" onClick={cfg.redo} disabled={cfg.redoStack.length === 0}>↷</button>
      </div>
      <div className="sep" />
      <div className="group">
        <button className="btn-sm" onClick={cfg.saveLayoutSnapshot} data-tip="Mémoriser la disposition actuelle">Mémoriser</button>
        <button className="btn-sm" onClick={cfg.restoreLayout} disabled={!cfg.savedLayout}>Restaurer la disposition</button>
        <button className="btn-sm" onClick={cfg.resetLayout}>Réinitialiser</button>
      </div>
      <div className="sep" />
      <div className="group" style={{ position: 'relative' }}>
        <button className="btn-sm" onClick={() => onOpen('hidden')}>
          Masqués{cfg.hiddenServices.length + cfg.hiddenConnections.length > 0 ? ` (${cfg.hiddenServices.length + cfg.hiddenConnections.length})` : ''}
        </button>
        <button className={`btn-sm ${filterCount ? 'btn-primary' : ''}`} onClick={() => setFilterOpen((v) => !v)}>
          Filtrer{filterCount ? ` (${filterCount})` : ''}
        </button>
        {filterOpen && (
          <div className="card card-pad" style={{ position: 'absolute', top: '110%', left: 0, zIndex: 50, width: 420, display: 'flex', gap: 18 }}>
            <div style={{ flex: 1 }}>
              <p className="card-title">Par état</p>
              {Object.entries(SERVICE_STATUS_LABELS).map(([k, v]) => (
                <label key={k} className="row small" style={{ cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={cfg.filters.statuses.includes(k)} onChange={() => toggle('statuses', k)} />
                  {v}
                </label>
              ))}
            </div>
            <div style={{ flex: 1 }}>
              <p className="card-title">Par type</p>
              {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => (
                <label key={k} className="row small" style={{ cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={cfg.filters.types.includes(k)} onChange={() => toggle('types', k)} />
                  {v}
                </label>
              ))}
              <button className="btn-sm" style={{ marginTop: 8 }}
                onClick={() => cfg.setFilters({ statuses: [], types: [] })}>
                Effacer les filtres
              </button>
            </div>
          </div>
        )}
        <input
          type="search"
          placeholder="Rechercher un service…"
          value={cfg.filters.search}
          onChange={(e) => cfg.setFilters({ search: e.target.value })}
          aria-label="Rechercher un service"
        />
      </div>
      <span className={`save-state ${cfg.saveState === 'error' ? 'error' : ''}`} style={{ marginLeft: 'auto' }}>
        {cfg.saveState === 'saved' && '✓ Modifications enregistrées'}
        {cfg.saveState === 'saving' && '⏳ Enregistrement…'}
        {cfg.saveState === 'error' && '⚠ Erreur de sauvegarde simulée — les changements restent en mémoire'}
      </span>
    </div>
  );
}
