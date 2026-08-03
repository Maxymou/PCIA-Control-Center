import { useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLiveStore } from '../../store/useLiveStore';
import { useConfigStore } from '../../store/useConfigStore';
import type { FanId, HardwareId } from '../../types';
import { fmtShortTime, fmtTime } from '../../utils/format';

// Couleurs prises dans la palette de courbes du design system : aucune valeur
// en dur ici, la teinte reste modifiable en un seul endroit (tokens.css).
const TEMP_SERIES: { id: HardwareId; label: string; color: string }[] = [
  { id: 'cpu', label: 'CPU', color: 'var(--chart-1)' },
  { id: 'v100-1', label: 'V100 n°1', color: 'var(--chart-2)' },
  { id: 'v100-2', label: 'V100 n°2', color: 'var(--chart-7)' },
  { id: 'gtx1080', label: 'GTX 1080', color: 'var(--chart-4)' },
  { id: 'nvme', label: 'NVMe', color: 'var(--chart-3)' },
  { id: 'motherboard', label: 'Carte mère', color: 'var(--chart-6)' },
];

const FAN_SERIES: { id: FanId; label: string; color: string }[] = [
  { id: 'CPU_FAN1', label: 'CPU_FAN1', color: 'var(--chart-1)' },
  { id: 'SYS_FAN1', label: 'SYS_FAN1', color: 'var(--chart-2)' },
  { id: 'SYS_FAN2', label: 'SYS_FAN2', color: 'var(--chart-3)' },
  { id: 'SYS_FAN3', label: 'SYS_FAN3', color: 'var(--chart-4)' },
  { id: 'SYS_FAN4', label: 'SYS_FAN4', color: 'var(--chart-5)' },
];

const tooltipStyle = {
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 12,
};

function LegendToggles<T extends string>({ series, hidden, onToggle }: {
  series: { id: T; label: string; color: string }[];
  hidden: Set<T>;
  onToggle: (id: T) => void;
}) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      {series.map((s) => (
        <button key={s.id} className={`legend-toggle ${hidden.has(s.id) ? '' : 'on'}`} onClick={() => onToggle(s.id)}>
          <span className="sw" style={{ background: hidden.has(s.id) ? 'var(--border-strong)' : s.color }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function TempHistoryChart() {
  const history = useLiveStore((s) => s.snap.history);
  const markers = useLiveStore((s) => s.snap.markers);
  const gtxInstalled = useLiveStore((s) => s.snap.hardware.find((h) => h.id === 'gtx1080')?.installed ?? false);
  const [hidden, setHidden] = useState<Set<HardwareId>>(new Set(['motherboard', 'nvme']));

  const data = useMemo(
    () => history.map((p) => ({ t: p.t, ...p.temps })),
    [history],
  );
  const series = TEMP_SERIES.filter((s) => s.id !== 'gtx1080' || gtxInstalled);

  return (
    <div className="card card-pad chart-card">
      <div className="spread">
        <p className="card-title" style={{ margin: 0 }}>Températures — 60 dernières minutes</p>
        <LegendToggles series={series} hidden={hidden}
          onToggle={(id) => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
          <XAxis dataKey="t" tickFormatter={fmtShortTime} stroke="var(--text-3)" fontSize={11}
            type="number" domain={['dataMin', 'dataMax']} tickCount={7} />
          <YAxis unit=" °C" stroke="var(--text-3)" fontSize={11} domain={[20, 100]} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(t) => fmtTime(Number(t))}
            formatter={(v: number | string, n) => [`${Number(v).toFixed(1)} °C`, series.find((s) => s.id === n)?.label ?? n]}
          />
          {markers.map((m, i) => (
            <ReferenceLine key={i} x={m.t}
              stroke={m.kind === 'alert' ? 'var(--crit)' : m.kind === 'profile' ? 'var(--accent)' : 'var(--text-3)'}
              strokeDasharray="3 3" label={{ value: m.kind === 'alert' ? '⚠' : m.kind === 'profile' ? '⚙' : '•', position: 'top', fontSize: 10, fill: 'var(--text-2)' }} />
          ))}
          {series.filter((s) => !hidden.has(s.id)).map((s) => (
            <Line key={s.id} dataKey={s.id} stroke={s.color} dot={false} strokeWidth={1.7} isAnimationActive={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FanHistoryChart() {
  const history = useLiveStore((s) => s.snap.history);
  const markers = useLiveStore((s) => s.snap.markers);
  const mode = useConfigStore((s) => s.prefs.fanChartMode);
  const setPrefs = useConfigStore((s) => s.setPrefs);
  const [hidden, setHidden] = useState<Set<FanId>>(new Set());

  const data = useMemo(
    () => history.map((p) => {
      const row: Record<string, number> = { t: p.t };
      for (const f of FAN_SERIES) {
        row[`rpm_${f.id}`] = p.rpm[f.id] ?? 0;
        row[`pwm_${f.id}`] = p.pwm[f.id] ?? 0;
      }
      return row;
    }),
    [history],
  );

  return (
    <div className="card card-pad chart-card">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <p className="card-title" style={{ margin: 0 }}>Ventilation — 60 dernières minutes</p>
        <div className="row">
          <select value={mode} onChange={(e) => setPrefs({ fanChartMode: e.target.value as 'rpm' | 'pwm' | 'both' })}
            aria-label="Grandeur affichée">
            <option value="rpm">RPM</option>
            <option value="pwm">PWM (%)</option>
            <option value="both">RPM + PWM</option>
          </select>
          <LegendToggles series={FAN_SERIES} hidden={hidden}
            onToggle={(id) => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: mode === 'both' ? 0 : 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
          <XAxis dataKey="t" tickFormatter={fmtShortTime} stroke="var(--text-3)" fontSize={11}
            type="number" domain={['dataMin', 'dataMax']} tickCount={7} />
          {(mode === 'rpm' || mode === 'both') && (
            <YAxis yAxisId="rpm" stroke="var(--text-3)" fontSize={11} unit="" />
          )}
          {(mode === 'pwm' || mode === 'both') && (
            <YAxis yAxisId="pwm" orientation={mode === 'both' ? 'right' : 'left'} stroke="var(--text-3)" fontSize={11} unit=" %" domain={[0, 100]} />
          )}
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(t) => fmtTime(Number(t))}
            formatter={(v: number | string, n: string) => {
              const isRpm = n.startsWith('rpm_');
              return [`${v}${isRpm ? ' RPM' : ' %'}`, n.replace(/^(rpm|pwm)_/, '') + (isRpm ? ' (RPM)' : ' (PWM)')];
            }}
          />
          {markers.map((m, i) => (
            <ReferenceLine key={i} x={m.t} yAxisId={mode === 'pwm' ? 'pwm' : 'rpm'}
              stroke={m.kind === 'alert' ? 'var(--crit)' : m.kind === 'profile' ? 'var(--accent)' : 'var(--text-3)'}
              strokeDasharray="3 3" />
          ))}
          {FAN_SERIES.filter((s) => !hidden.has(s.id)).flatMap((s) => [
            ...(mode === 'rpm' || mode === 'both'
              ? [<Line key={`rpm_${s.id}`} yAxisId="rpm" dataKey={`rpm_${s.id}`} stroke={s.color} dot={false} strokeWidth={1.7} isAnimationActive={false} />]
              : []),
            ...(mode === 'pwm' || mode === 'both'
              ? [<Line key={`pwm_${s.id}`} yAxisId="pwm" dataKey={`pwm_${s.id}`} stroke={s.color} dot={false} strokeWidth={1.2}
                  strokeDasharray={mode === 'both' ? '4 3' : undefined} isAnimationActive={false} />]
              : []),
          ])}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
