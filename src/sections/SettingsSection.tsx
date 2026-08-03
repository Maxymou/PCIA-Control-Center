/** Paramètres — préférences d'affichage, source de données, outils.
 *
 *  Rassemble ce qui était auparavant dispersé : la case « pulsations » perdue
 *  dans une carte de synthèse, le panneau de démonstration flottant, et les
 *  informations de source de données visibles seulement en infobulle.
 */

import { useConfigStore } from '../store/useConfigStore';
import { useLiveStore } from '../store/useLiveStore';
import { providerInfo } from '../services/dataService';
import { DevPanel } from '../components/DevPanel';
import { fmtDateTime } from '../utils/format';

const SOURCE_LABELS: Record<string, string> = {
  mock: 'Simulation locale au navigateur (aucun back-end joignable)',
  demo: 'Back-end en mode démonstration (mesures simulées côté serveur)',
  hardware: 'Back-end en mode matériel (mesures réelles)',
};

export function SettingsSection() {
  const prefs = useConfigStore((s) => s.prefs);
  const setPrefs = useConfigStore((s) => s.setPrefs);
  const resetLayout = useConfigStore((s) => s.resetLayout);
  const system = useLiveStore((s) => s.snap.system);
  const provider = providerInfo();
  const mode = system?.mode ?? provider.mode;

  return (
    <div className="section">
      <div className="section__inner">
        {/* --- Affichage --- */}
        <section className="card card-pad" aria-labelledby="reglages-affichage">
          <h2 className="card-title" id="reglages-affichage">Affichage</h2>
          <div className="col">
            <label>
              <input
                type="checkbox"
                checked={prefs.pulseAnimations}
                onChange={(e) => setPrefs({ pulseAnimations: e.target.checked })}
              />
              Faire clignoter les indicateurs critiques
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              Le clignotement attire l’œil sur un incident. Il est automatiquement
              désactivé si le système annonce une préférence de mouvement réduit.
            </p>

            <div className="divider" />

            <label className="field" style={{ maxWidth: 260 }}>
              Grandeur affichée dans l’historique de ventilation
              <select
                value={prefs.fanChartMode}
                onChange={(e) => setPrefs({ fanChartMode: e.target.value as 'rpm' | 'pwm' | 'both' })}
              >
                <option value="rpm">Vitesse (RPM)</option>
                <option value="pwm">Consigne (PWM %)</option>
                <option value="both">Les deux</option>
              </select>
            </label>
          </div>
        </section>

        {/* --- Source des données --- */}
        <section className="card card-pad" aria-labelledby="reglages-source">
          <h2 className="card-title" id="reglages-source">Source des données</h2>
          <dl className="kv">
            <dt>Source</dt>
            <dd>{SOURCE_LABELS[mode] ?? mode}</dd>
            <dt>Version</dt>
            <dd className="mono">{system?.version ?? provider.version ?? '—'}</dd>
            {provider.fallbackReason && (
              <>
                <dt>Motif du repli</dt>
                <dd className="small">{provider.fallbackReason}</dd>
              </>
            )}
            {system && (
              <>
                <dt>Hôte</dt>
                <dd className="mono">{system.hostname}</dd>
                <dt>Distribution</dt>
                <dd className="mono">{system.distribution}</dd>
                <dt>Noyau</dt>
                <dd className="mono">{system.kernel}</dd>
                <dt>Démarré le</dt>
                <dd className="mono">{fmtDateTime(system.startedAt)}</dd>
                <dt>Moteur de ventilation</dt>
                <dd>
                  {system.fanEngine.online ? 'En ligne' : 'Hors ligne'}
                  {system.fanEngine.embedded ? ' (embarqué)' : ''}
                  {system.fanEngine.failsafe ? ' — mode de repli actif' : ''}
                </dd>
              </>
            )}
          </dl>

          {system?.degraded && system.degradedReasons.length > 0 && (
            <div className="banner banner--warning" style={{ marginTop: 'var(--sp-3)' }}>
              <div className="banner__body">
                <p className="banner__title">Supervision dégradée</p>
                <ul style={{ margin: 'var(--sp-1) 0 0', paddingLeft: '1.1rem' }}>
                  {system.degradedReasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* --- Capacités --- */}
        {system && (
          <section className="card card-pad" aria-labelledby="reglages-capacites">
            <h2 className="card-title" id="reglages-capacites">Capacités détectées</h2>
            <p className="small muted">
              Ce que la machine sait réellement faire. Une capacité absente désactive
              les commandes correspondantes plutôt que de les faire échouer.
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Capacités du back-end</caption>
                <thead>
                  <tr>
                    <th scope="col">Capacité</th>
                    <th scope="col">Disponible</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(CAPABILITY_LABELS).map(([key, label]) => {
                    const available = system.capabilities[key as keyof typeof CAPABILITY_LABELS] as boolean;
                    return (
                      <tr key={key}>
                        <th scope="row" style={{ fontWeight: 'inherit' }}>{label}</th>
                        <td>
                          <span className={`badge ${available ? 'normal' : ''}`}>
                            {available ? 'Oui' : 'Non'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* --- Disposition --- */}
        <section className="card card-pad" aria-labelledby="reglages-disposition">
          <h2 className="card-title" id="reglages-disposition">Disposition du graphe</h2>
          <p className="small muted">
            Réinitialise uniquement le placement des blocs de la section Services et
            connexions. Les services, connexions, corrections et notes sont conservés.
          </p>
          <button type="button" onClick={resetLayout}>Réinitialiser la disposition</button>
        </section>

        <DevPanel inline />
      </div>
    </div>
  );
}

const CAPABILITY_LABELS = {
  canReadTemperature: 'Lecture des températures',
  canReadRpm: 'Lecture des vitesses de rotation',
  canWritePwm: 'Écriture des consignes PWM',
  canReturnToBios: 'Restitution du contrôle au BIOS',
  canDetectServices: 'Détection des services',
  canDetectConnections: 'Détection des connexions',
  canReadGpuPower: 'Lecture de la consommation GPU',
  canReadStorageSmart: 'Lecture de l’état SMART du stockage',
  canControlFans: 'Pilotage des ventilateurs',
} as const;
