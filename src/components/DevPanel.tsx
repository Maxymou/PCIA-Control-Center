import { useState } from 'react';
import { dataService } from '../services/dataService';
import { useConfigStore } from '../store/useConfigStore';
import { useLiveStore } from '../store/useLiveStore';
import { Confirm } from './Common';

/** Outil de démonstration — permet de déclencher manuellement des scénarios simulés.
 *  N'existe que pour la démo front-end ; à retirer avec les mocks. */
export function DevPanel() {
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const gtx = useLiveStore((s) => s.snap.hardware.find((h) => h.id === 'gtx1080')?.installed);
  const triggerSaveError = useConfigStore((s) => s.triggerSaveError);
  const resetAll = useConfigStore((s) => s.resetAll);
  const d = dataService.demo;

  return (
    <div className="dev-panel card">
      <div className="head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((v) => !v)}>
        <span>🧪 Mode démonstration</span>
        <span>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="body">
          <div className="small muted" style={{ marginBottom: 2 }}>
            Déclencheurs de scénarios simulés (outil de démo, sans effet réel).
          </div>
          <button onClick={d.heatUpV100}>🌡 Montée en température V100 n°2</button>
          <button onClick={d.blockFan}>🌀 Bloquer SYS_FAN4</button>
          <button onClick={d.stopService}>⛔ Arrêt inattendu d’OpenWebUI</button>
          <button onClick={d.loseConnection}>🔌 Perte de connexion OpenWebUI → vLLM</button>
          <button onClick={d.detectNewService}>🔍 Détecter un nouveau service (Grafana)</button>
          <button onClick={d.conflictingDetection}>⚠ Détection contredisant une correction</button>
          <button onClick={d.toggleGtx}>{gtx ? '🗑 Retirer la GTX 1080' : '➕ Installer la GTX 1080'}</button>
          <button onClick={d.newAlert}>🔔 Nouvelle alerte NVMe</button>
          <button onClick={triggerSaveError}>💾 Simuler une erreur de sauvegarde</button>
          <button onClick={d.toggleBackend}>📡 Basculer l’état du back-end simulé</button>
          <button onClick={d.backToNormal}>✅ Retour à l’état normal</button>
          <div className="divider" style={{ margin: '4px 0' }} />
          <button className="btn-danger" onClick={() => setConfirmReset(true)}>
            ♻ Réinitialiser toutes les données locales
          </button>
        </div>
      )}
      {confirmReset && (
        <Confirm
          message="Réinitialiser toutes les données locales de démonstration ? La disposition, les notes, les profils personnalisés et les préférences seront perdus."
          confirmLabel="Tout réinitialiser"
          onConfirm={resetAll}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
