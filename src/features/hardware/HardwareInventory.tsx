/** Inventaire matériel.
 *
 *  Le schéma montre les associations entre sorties de ventilation et matériel ;
 *  cet inventaire montre l'état de chaque composant, y compris ceux que le
 *  schéma ne peut pas représenter (mémoire, capteurs de carte mère) et ceux qui
 *  sont **absents** — un emplacement PCIe libre est une information, pas un
 *  vide à masquer.
 *
 *  Chaque grandeur passe par `Measure` : une valeur simulée, indisponible ou
 *  issue d'un capteur absent ne prend jamais l'apparence d'une mesure réelle.
 */

import { useLiveStore } from '../../store/useLiveStore';
import { useUiStore } from '../../store/useUiStore';
import { StatusDot } from '../../components/Common';
import { Measure, useProvenance } from '../../ui/Measure';
import { SEVERITY_LABELS } from '../../utils/labels';
import type { HardwareItem } from '../../types';

const KIND_LABELS: Record<HardwareItem['kind'], string> = {
  cpu: 'Processeur',
  gpu: 'Carte graphique',
  storage: 'Stockage',
  case: 'Boîtier',
  board: 'Carte mère',
};

function HardwareCard({ item }: { item: HardwareItem }) {
  const selected = useUiStore((s) => s.selectedHardwareId === item.id);
  const selectHardware = useUiStore((s) => s.selectHardware);
  const { base, missingFor } = useProvenance();
  const m = item.metrics;

  if (!item.installed) {
    return (
      <li className="panel card-pad hw-card hw-card--absent">
        <div className="spread">
          <span className="muted">{item.name}</span>
          <span className="badge outline">Non installé</span>
        </div>
        {item.pcieSlot && (
          <p className="small muted mono" style={{ margin: 'var(--sp-1) 0 0' }}>
            {item.pcieSlot} — emplacement libre
          </p>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`panel card-pad hw-card${selected ? ' hw-card--selected' : ''}`}
        aria-pressed={selected}
        onClick={() => selectHardware(selected ? null : item.id)}
      >
        <div className="spread">
          <span className="row">
            <StatusDot sev={m.status} pulse={m.status === 'critical'} />
            <strong>{item.name}</strong>
          </span>
          <span className="small muted">{KIND_LABELS[item.kind]}</span>
        </div>

        {item.model && <p className="small muted" style={{ margin: 'var(--sp-1) 0 0' }}>{item.model}</p>}

        <dl className="kv" style={{ marginTop: 'var(--sp-2)' }}>
          <dt>État</dt>
          <dd className={`sev-${m.status}`}>{SEVERITY_LABELS[m.status]}</dd>

          {item.pcieSlot && (<><dt>Emplacement</dt><dd className="mono">{item.pcieSlot}</dd></>)}

          <dt>Température</dt>
          <dd>
            <Measure value={m.temp} unit="°C" digits={1} provenance={base}
              missingAs={missingFor('canReadTemperature')} />
          </dd>

          {(m.load !== undefined || item.kind === 'cpu' || item.kind === 'gpu') && (
            <><dt>Charge</dt>
              <dd><Measure value={m.load} unit="%" provenance={base} /></dd></>
          )}

          {m.freq !== undefined && (
            <><dt>Fréquence</dt>
              <dd><Measure value={m.freq} unit="MHz" provenance={base} /></dd></>
          )}

          {(m.power !== undefined || item.kind === 'gpu') && (
            <><dt>Consommation</dt>
              <dd><Measure value={m.power} unit="W" provenance={base}
                missingAs={missingFor('canReadGpuPower')} /></dd></>
          )}

          {m.memTotal !== undefined && (
            <><dt>Mémoire</dt>
              <dd>
                <Measure value={m.memUsed} unit="Go" digits={1} provenance={base} />
                <span className="muted"> / {m.memTotal} Go</span>
              </dd></>
          )}

          {m.capacity !== undefined && (
            <><dt>Capacité</dt>
              <dd>
                <Measure value={m.used} unit="Go" provenance={base} />
                <span className="muted"> / {m.capacity} Go</span>
              </dd></>
          )}

          {(m.health !== undefined || item.kind === 'storage') && (
            <><dt>Santé</dt>
              <dd><Measure value={m.health} unit="%" provenance={base}
                missingAs={missingFor('canReadStorageSmart')} /></dd></>
          )}

          {m.activity !== undefined && (
            <><dt>Activité</dt>
              <dd><Measure value={m.activity} unit="%" provenance={base} /></dd></>
          )}
        </dl>
      </button>
    </li>
  );
}

export function HardwareInventory() {
  const hardware = useLiveStore((s) => s.snap.hardware);
  // Les zones de boîtier n'ont pas d'existence matérielle propre : elles
  // servent au schéma d'attribution, pas à l'inventaire.
  const components = hardware.filter((h) => h.kind !== 'case');

  return (
    <section className="card card-pad" aria-labelledby="titre-inventaire">
      <h2 className="card-title" id="titre-inventaire">Composants</h2>
      {components.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Aucun composant détecté. Vérifier que le back-end a accès à
          <code> /sys/class/hwmon</code> et aux outils de supervision.
        </p>
      ) : (
        <ul className="hw-inventory">
          {components.map((item) => <HardwareCard key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  );
}
