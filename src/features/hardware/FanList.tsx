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
