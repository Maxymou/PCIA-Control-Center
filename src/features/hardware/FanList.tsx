import { useLiveStore } from '../../store/useLiveStore';
import { useConfigStore } from '../../store/useConfigStore';
import { useUiStore } from '../../store/useUiStore';
import { StatusDot } from '../../components/Common';
import { FAN_MODE_LABELS } from '../../utils/labels';
import { round1 } from '../../utils/format';

export function FanList() {
  const fanConfigs = useConfigStore((s) => s.fanConfigs);
  const fansLive = useLiveStore((s) => s.snap.fans);
  const ui = useUiStore();

  return (
    <div className="card card-pad">
      <p className="card-title">Sorties ventilateur</p>
      <div className="col" style={{ gap: 4 }}>
        {fanConfigs.map((f) => {
          const lv = fansLive.find((x) => x.id === f.id);
          return (
            <div
              key={f.id}
              className={`fan-row ${ui.selectedFanId === f.id ? 'selected' : ''}`}
              onClick={() => ui.selectFan(f.id)}
              role="button" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && ui.selectFan(f.id)}
            >
              <div className="row">
                <StatusDot sev={lv?.status ?? 'unknown'} pulse={lv?.status === 'critical'} />
                <strong>{f.displayName}</strong>
                <span className="muted small mono">{f.id}</span>
              </div>
              <div className="mono small" style={{ textAlign: 'right' }}>
                {lv ? `${lv.rpm} RPM` : '—'}
              </div>
              <div className="small muted">{FAN_MODE_LABELS[f.mode]}</div>
              <div className="mono small muted" style={{ textAlign: 'right' }}>
                {lv ? `${lv.pwm} % · ${round1(lv.refTemp)} °C` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Détails du matériel sélectionné dans le schéma. */
export function HardwareDetails() {
  const id = useUiStore((s) => s.selectedHardwareId);
  const hardware = useLiveStore((s) => s.snap.hardware);
  const h = hardware.find((x) => x.id === id);
  if (!h || !h.installed) return null;
  const m = h.metrics;
  return (
    <div className="card card-pad">
      <div className="spread">
        <p className="card-title" style={{ margin: 0 }}>{h.name}</p>
        <StatusDot sev={m.status} pulse={m.status === 'critical'} />
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        {h.model && <><dt>Modèle</dt><dd>{h.model}</dd></>}
        {h.pcieSlot && <><dt>Emplacement</dt><dd className="mono">{h.pcieSlot}</dd></>}
        {m.temp !== undefined && <><dt>Température</dt><dd className={`mono sev-${m.status}`}>{m.temp.toFixed(1)} °C</dd></>}
        {m.load !== undefined && <><dt>Charge</dt><dd className="mono">{m.load} %</dd></>}
        {m.freq !== undefined && <><dt>Fréquence</dt><dd className="mono">{m.freq} MHz</dd></>}
        {m.power !== undefined && <><dt>Consommation</dt><dd className="mono">{m.power} W</dd></>}
        {m.memUsed !== undefined && <><dt>Mémoire</dt><dd className="mono">{m.memUsed.toFixed(1)} / {m.memTotal} Go</dd></>}
        {m.capacity !== undefined && <><dt>Capacité</dt><dd className="mono">{m.used} / {m.capacity} Go</dd></>}
        {m.health !== undefined && <><dt>État de santé</dt><dd className="mono">{m.health} %</dd></>}
        {m.activity !== undefined && <><dt>Activité</dt><dd className="mono">{m.activity} %</dd></>}
      </dl>
    </div>
  );
}
