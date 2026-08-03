import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Ordre significatif : jetons, puis socle, puis composants, puis mise en page.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import '@xyflow/react/dist/style.css';
import { bootLiveData } from './store/useLiveStore';
import { bootConfig } from './store/useConfigStore';
import { initDataService, providerInfo } from './services/dataService';

const root = ReactDOM.createRoot(document.getElementById('root')!);

/** Écran transitoire pendant la détection du back-end (quelques centaines de ms). */
function renderSplash() {
  root.render(
    <div className="app-viewport" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="col" style={{ alignItems: 'center' }}>
        <div className="logo" style={{ width: 44, height: 44, fontSize: 22 }}>P</div>
        <p className="muted" role="status">Connexion au back-end…</p>
      </div>
    </div>,
  );
}

/** Ordre d'amorçage :
 *   1. choisir la source de données (back-end réel ou simulation locale) ;
 *   2. restaurer la configuration (serveur puis repli local) ;
 *   3. ouvrir le flux temps réel ;
 *   4. afficher l'interface.
 *  Les composants ne sont montés qu'une fois les données disponibles : aucun
 *  rendu intermédiaire avec des tableaux vides. */
async function boot() {
  renderSplash();

  const info = await initDataService();
  // Trace utile au diagnostic : quelle source alimente réellement l'interface.
  console.info(
    `[PCIA] source de données : ${info.kind}${info.mode !== 'mock' ? ` (mode ${info.mode})` : ''}`,
    info.fallbackReason ?? '',
  );

  await bootConfig();
  bootLiveData();

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot().catch((err) => {
  console.error('[PCIA] démarrage impossible', err);
  root.render(
    <div className="app-viewport" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card card-pad col" role="alert" style={{ maxWidth: 520 }}>
        <p className="card-title">Démarrage impossible</p>
        <p className="small muted">{String((err as Error)?.message ?? err)}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>Réessayer</button>
      </div>
    </div>,
  );
});

export { providerInfo };
