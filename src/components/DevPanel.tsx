import { useState } from 'react';
import { dataService, providerInfo } from '../services/dataService';
import { useConfigStore } from '../store/useConfigStore';
import { useLiveStore } from '../store/useLiveStore';
import { Confirm } from './Common';

/** Outil de démonstration : déclenche des scénarios simulés.
 *
 *  Disponible uniquement quand les données sont simulées (simulation locale ou
 *  back-end en mode démo). En mode matériel, aucun scénario n'est jouable —
 *  l'application n'invente jamais de données sur une vraie machine. */
export function DevPanel({ inline = false }: { inline?: boolean } = {}) {
  // `inline` : intégré au flux de la section Paramètres plutôt que flottant.
  const [open, setOpen] = useState(inline);
  const [confirmReset, setConfirmReset] = useState(false);
  const gtx = useLiveStore((s) => s.snap.hardware.find((h) => h.id === 'gtx1080')?.installed);
  const system = useLiveStore((s) => s.snap.system);
  const triggerSaveError = useConfigStore((s) => s.triggerSaveError);
  const resetAll = useConfigStore((s) => s.resetAll);
  const d = dataService.demo;

  const mode = system?.mode ?? providerInfo().mode;
  const simulated = mode !== 'hardware';

  return (
    <div className={`dev-panel card${inline ? ' dev-panel--inline' : ''}`}>
      <button
        type="button"
        className="head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>🧪 Mode démonstration</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="body">
          {simulated ? (
            <>
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
            </>
          ) : (
            <div className="small muted" style={{ marginBottom: 2 }}>
              Back-end en <b>mode matériel</b> : les scénarios simulés sont désactivés.
              Toutes les valeurs affichées proviennent de mesures réelles.
              {system?.degraded && system.degradedReasons.length > 0 && (
                <>
                  <div className="divider" style={{ margin: '6px 0' }} />
                  <b>Limitations détectées :</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                    {system.degradedReasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
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
