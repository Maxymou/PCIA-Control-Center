import { useLiveStore } from '../../store/useLiveStore';
import { useConfigStore } from '../../store/useConfigStore';
import { useActiveAlerts, useGlobalStatus } from '../../store/selectors';
import { SEVERITY_LABELS } from '../../utils/labels';
import { StatusDot } from '../../components/Common';
import { HardwareSchema } from './HardwareSchema';
import { FanList, HardwareDetails } from './FanList';
import { FanSettings } from './FanSettings';
import { ProfilesBar } from './ProfilesBar';
import { FanHistoryChart, TempHistoryChart } from './HistoryCharts';
import { EventsList } from './EventsList';

function SummaryCards() {
  const hardware = useLiveStore((s) => s.snap.hardware);
  const alerts = useActiveAlerts();
  const status = useGlobalStatus();
  const cfg = useConfigStore();
  const cpu = hardware.find((h) => h.id === 'cpu');
  const gpus = hardware.filter((h) => h.kind === 'gpu' && h.installed);
  const hottest = gpus.reduce((a, b) => ((b.metrics.temp ?? 0) > (a?.metrics.temp ?? -1) ? b : a), gpus[0]);
  const nvme = hardware.find((h) => h.id === 'nvme');
  const profile = [...cfg.builtinProfiles, ...cfg.customProfiles].find((p) => p.id === cfg.activeProfileId);
  const pulse = useConfigStore((s) => s.prefs.pulseAnimations);

  return (
    <div className="hw-summary">
      <div className="card card-pad">
        <div className="lbl">État global</div>
        <div className="row"><StatusDot sev={status} pulse={status === 'critical'} />
          <span className={`big sev-${status}`} style={{ fontSize: 17 }}>{SEVERITY_LABELS[status]}</span></div>
      </div>
      <div className="card card-pad">
        <div className="lbl">CPU</div>
        <div className={`big sev-${cpu?.metrics.status ?? 'unknown'}`}>{cpu?.metrics.temp?.toFixed(0) ?? '—'} °C</div>
        <div className="small muted mono">{cpu?.metrics.load ?? '—'} % de charge</div>
      </div>
      <div className="card card-pad">
        <div className="lbl">GPU le plus chaud</div>
        <div className={`big sev-${hottest?.metrics.status ?? 'unknown'}`}>{hottest?.metrics.temp?.toFixed(0) ?? '—'} °C</div>
        <div className="small muted">{hottest?.name ?? 'Aucun GPU'}</div>
      </div>
      <div className="card card-pad">
        <div className="lbl">SSD NVMe</div>
        <div className={`big sev-${nvme?.metrics.status ?? 'unknown'}`}>{nvme?.metrics.temp?.toFixed(0) ?? '—'} °C</div>
        <div className="small muted mono">Santé {nvme?.metrics.health ?? '—'} %</div>
      </div>
      <div className="card card-pad">
        <div className="lbl">Profil actif</div>
        <div className="big" style={{ fontSize: 17, fontFamily: 'var(--font)' }}>{profile?.name ?? '—'}</div>
        <label className="row small muted" style={{ cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" checked={pulse} onChange={(e) => cfg.setPrefs({ pulseAnimations: e.target.checked })} />
          Pulsations critiques
        </label>
      </div>
      <div className="card card-pad">
        <div className="lbl">Alertes actives</div>
        <div className={`big ${alerts.length ? 'sev-warning' : ''}`}>{alerts.length}</div>
        <div className="small muted">
          dont <b className={alerts.some((a) => a.level === 'critical') ? 'sev-critical' : ''}>
            {alerts.filter((a) => a.level === 'critical').length}
          </b> critique(s)
        </div>
      </div>
    </div>
  );
}

export function HardwareTab() {
  return (
    <div className="hardware">
      <SummaryCards />
      <ProfilesBar />
      <div className="hw-main">
        <HardwareSchema />
        <div className="col" style={{ gap: 14 }}>
          <FanList />
          <HardwareDetails />
        </div>
        <FanSettings />
      </div>
      <div className="hw-history">
        <TempHistoryChart />
        <FanHistoryChart />
      </div>
      <EventsList />
    </div>
  );
}
