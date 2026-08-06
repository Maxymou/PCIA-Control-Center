/** Vue d'ensemble — synthèse de l'état du serveur.
 *
 *  Ne calcule rien de nouveau : compose les sélecteurs existants pour donner en
 *  un écran ce qu'il fallait auparavant chercher dans deux onglets.
 */

import { useLiveStore } from '../store/useLiveStore';
import { useConfigStore } from '../store/useConfigStore';
import { useActiveAlerts, useGlobalStatus } from '../store/selectors';
import { SERVICE_STATUS_SEVERITY, SEVERITY_LABELS } from '../utils/labels';
import { fmtTime, round1 } from '../utils/format';
import { StatusDot } from '../components/Common';
import { providerInfo } from '../services/dataService';
import { useUiStore } from '../store/useUiStore';
import { useIsMobile } from '../ui/useBreakpoint';
import { Measure, ProvenanceBadge, useProvenance } from '../ui/Measure';
import { formatAge, useConnectionState } from '../ui/useConnectionState';
import type { SectionId } from '../ui/sections';

const MODE_LABELS: Record<string, string> = {
  hardware: 'Matériel',
  demo: 'Démonstration',
  mock: 'Simulation navigateur',
};

/** Carte de synthèse cliquable : mène à la section qui détaille la valeur. */
function StatCard({ label, children, goTo, hint }: {
  label: string;
  children: React.ReactNode;
  goTo?: SectionId;
  hint?: string;
}) {
  const setTab = useUiStore((s) => s.setTab);
  const content = (
    <>
      <div className="lbl">{label}</div>
      {children}
      {hint && <div className="small muted">{hint}</div>}
    </>
  );

  if (!goTo) return <div className="card card-pad stat-card">{content}</div>;

  return (
    <button
      type="button"
      className="card card-pad stat-card stat-card--link"
      onClick={() => setTab(goTo)}
    >
      {content}
    </button>
  );
}

export function OverviewSection() {
  const hardware = useLiveStore((s) => s.snap.hardware);
  const fans = useLiveStore((s) => s.snap.fans);
  const services = useLiveStore((s) => s.snap.services);
  const time = useLiveStore((s) => s.snap.time);
  const system = useLiveStore((s) => s.snap.system);
  const activeProfileId = useConfigStore((s) => s.activeProfileId);
  const builtinProfiles = useConfigStore((s) => s.builtinProfiles);
  const customProfiles = useConfigStore((s) => s.customProfiles);
  const alerts = useActiveAlerts();
  const status = useGlobalStatus();
  const isMobile = useIsMobile();
  const link = useConnectionState();
  const { base, missingFor } = useProvenance();

  const cpu = hardware.find((h) => h.id === 'cpu');
  const nvme = hardware.find((h) => h.id === 'nvme');
  const gpus = hardware.filter((h) => h.kind === 'gpu' && h.installed);
  const hottestGpu = gpus.reduce<typeof gpus[number] | undefined>(
    (best, gpu) => ((gpu.metrics.temp ?? -1) > (best?.metrics.temp ?? -1) ? gpu : best),
    undefined,
  );
  const gpuPower = gpus.reduce((sum, gpu) => sum + (gpu.metrics.power ?? 0), 0);
  const profile = [...builtinProfiles, ...customProfiles].find((p) => p.id === activeProfileId);
  const criticalServices = services.filter((s) => SERVICE_STATUS_SEVERITY[s.status] === 'critical');
  const stalledFans = fans.filter((f) => f.stalled);
  const criticalAlerts = alerts.filter((a) => a.level === 'critical');

  const mode = system?.mode ?? providerInfo().mode;

  return (
    <div className="section">
      <div className="section__inner">
        <div className="grid-cards">
          <StatCard label="État général">
            <div className="row">
              <StatusDot sev={status} pulse={status === 'critical'} />
              <span className={`big big--text sev-${status}`}>{SEVERITY_LABELS[status]}</span>
            </div>
          </StatCard>

          <StatCard label="Mode d’exécution" goTo="settings" hint={system?.degraded ? 'Supervision dégradée' : undefined}>
            <div className="row">
              <span className="big big--text">{MODE_LABELS[mode] ?? mode}</span>
              <ProvenanceBadge provenance={base} />
            </div>
          </StatCard>

          <StatCard label="Processeur" goTo="hardware" hint={cpu?.metrics.load !== undefined ? `${cpu.metrics.load} % de charge` : undefined}>
            <div className={`big sev-${cpu?.metrics.status ?? 'unknown'}`}>
              <Measure
                value={cpu?.metrics.temp}
                unit="°C"
                provenance={base}
                missingAs={missingFor('canReadTemperature')}
              />
            </div>
          </StatCard>

          <StatCard label="GPU le plus chaud" goTo="hardware" hint={hottestGpu?.name ?? 'Aucun GPU détecté'}>
            <div className={`big sev-${hottestGpu?.metrics.status ?? 'unknown'}`}>
              <Measure
                value={hottestGpu?.metrics.temp}
                unit="°C"
                provenance={base}
                missingAs={missingFor('canReadTemperature')}
              />
            </div>
          </StatCard>

          <StatCard label="Puissance GPU" goTo="hardware" hint={`${gpus.length} carte(s) détectée(s)`}>
            <div className="big">
              <Measure
                value={gpuPower > 0 ? gpuPower : null}
                unit="W"
                provenance={base}
                missingAs={missingFor('canReadGpuPower')}
                hint="somme des consommations instantanées des cartes détectées"
              />
            </div>
          </StatCard>

          <StatCard label="Stockage NVMe" goTo="hardware" hint={nvme?.metrics.health !== undefined ? `Santé ${nvme.metrics.health} %` : undefined}>
            <div className={`big sev-${nvme?.metrics.status ?? 'unknown'}`}>
              <Measure
                value={nvme?.metrics.temp}
                unit="°C"
                provenance={base}
                missingAs={missingFor('canReadStorageSmart')}
              />
            </div>
          </StatCard>

          <StatCard label="Profil de ventilation" goTo="fans">
            <div className="big big--text">{profile?.name ?? '—'}</div>
          </StatCard>

          <StatCard
            label="Alertes actives"
            goTo="alerts"
            hint={`dont ${criticalAlerts.length} critique(s)`}
          >
            <div className={`big ${alerts.length ? 'sev-warning' : ''}`}>{alerts.length}</div>
          </StatCard>
        </div>

        {/* Sur écran large, ventilation et points d'attention se partagent la
            largeur : la vue reste dense plutôt que de laisser un grand vide. */}
        <div className="grid-2">
        {/* --- Ventilation --- */}
        <section className="card card-pad" aria-labelledby="apercu-ventilation">
          <div className="spread">
            <h2 className="card-title" id="apercu-ventilation" style={{ margin: 0 }}>Ventilation</h2>
            <span className="small muted mono">
              Actualisé à {fmtTime(time)}
              {link.status !== 'live' && ` — ${formatAge(link.ageMs)}`}
            </span>
          </div>
          {fans.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>Aucune sortie de ventilation détectée.</p>
          ) : isMobile ? (
            /* Sur mobile, un tableau à cinq colonnes n'est pas lisible : chaque
               sortie devient une carte. L'information est identique, seule la
               présentation change — aucune colonne n'est supprimée. */
            <ul className="col" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {fans.map((fan) => (
                <li key={fan.id} className="panel card-pad">
                  <div className="spread">
                    <strong className="mono">{fan.id}</strong>
                    <span className="row">
                      <StatusDot sev={fan.status} />
                      <span className="small">{SEVERITY_LABELS[fan.status]}</span>
                      {fan.stalled && <span className="badge critical">Bloqué</span>}
                    </span>
                  </div>
                  <dl className="kv" style={{ marginTop: 'var(--sp-2)' }}>
                    <dt>Consigne</dt>
                    <dd><Measure value={fan.pwm} unit="%" provenance={base} /></dd>
                    <dt>Vitesse</dt>
                    <dd><Measure value={fan.rpm} unit="RPM" provenance={base} missingAs={missingFor('canReadRpm')} /></dd>
                    <dt>Température de référence</dt>
                    <dd><Measure value={round1(fan.refTemp)} unit="°C" digits={1} provenance={base} missingAs={missingFor('canReadTemperature')} /></dd>
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">
                  État des sorties de ventilation : consigne, vitesse et température de référence
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Sortie</th>
                    <th scope="col">État</th>
                    <th scope="col">Consigne</th>
                    <th scope="col">Vitesse</th>
                    <th scope="col">Température de référence</th>
                  </tr>
                </thead>
                <tbody>
                  {fans.map((fan) => (
                    <tr key={fan.id}>
                      <th scope="row" className="mono">{fan.id}</th>
                      <td>
                        <span className="row">
                          <StatusDot sev={fan.status} />
                          {SEVERITY_LABELS[fan.status]}
                          {fan.stalled && <span className="badge critical">Bloqué</span>}
                        </span>
                      </td>
                      <td><Measure value={fan.pwm} unit="%" provenance={base} /></td>
                      <td><Measure value={fan.rpm} unit="RPM" provenance={base} missingAs={missingFor('canReadRpm')} /></td>
                      <td><Measure value={round1(fan.refTemp)} unit="°C" digits={1} provenance={base} missingAs={missingFor('canReadTemperature')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* --- Points d'attention --- */}
        <section className="card card-pad" aria-labelledby="apercu-attention">
          <h2 className="card-title" id="apercu-attention">Points d’attention</h2>
          {criticalAlerts.length === 0 && criticalServices.length === 0 && stalledFans.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Aucun incident en cours : aucune alerte critique, aucun service en défaut,
              aucun ventilateur bloqué.
            </p>
          ) : (
            <ul className="col" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {criticalAlerts.map((alert) => (
                <li key={alert.id} className="small">
                  <b className="sev-critical">Alerte critique</b> — {alert.targetLabel} : {alert.message}
                </li>
              ))}
              {stalledFans.map((fan) => (
                <li key={fan.id} className="small">
                  <b className="sev-critical">Ventilateur bloqué</b> — {fan.id} : consigne appliquée
                  sans retour tachymétrique.
                </li>
              ))}
              {criticalServices.map((service) => (
                <li key={service.id} className="small">
                  <b className="sev-critical">Service en défaut</b> — {service.displayName ?? service.name}
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}
