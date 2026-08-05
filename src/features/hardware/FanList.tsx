import { useLiveStore } from '../../store/useLiveStore';
import { useConfigStore } from '../../store/useConfigStore';
import { useUiStore } from '../../store/useUiStore';
import { StatusDot } from '../../components/Common';
import { FAN_MODE_LABELS } from '../../utils/labels';
import { fmtRpmShort, rpmAriaLabel, round1 } from '../../utils/format';
import type { HardwareId } from '../../types';

export function FanList() {
  const fanConfigs = useConfigStore((s) => s.fanConfigs);
  const fansLive = useLiveStore((s) => s.snap.fans);
  const hardware = useLiveStore((s) => s.snap.hardware);
  const ui = useUiStore();

  /** Matériel refroidi par une sortie, en clair. Le nom vient de l'inventaire
   *  remonté par le back-end : aucun libellé matériel n'est figé ici. */
  const hardwareLabel = (id: HardwareId | 'none' | 'custom', custom?: string): string => {
    if (id === 'custom') return custom ?? 'matériel personnalisé';
    if (id === 'none') return 'aucun matériel';
    return hardware.find((h) => h.id === id)?.name ?? id;
  };

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
                {/* Connecteur physique de la carte mère, puis matériel refroidi. */}
                <span className="muted small mono">{f.id}</span>
              </div>
              <div
                className="mono small"
                style={{ textAlign: 'right' }}
                title={lv?.rpmSource === 'simulated' ? 'Valeur simulée (mode démonstration)' : undefined}
              >
                <span aria-hidden="true">{fmtRpmShort(lv?.rpm, lv?.rpmSource)}</span>
                <span className="sr-only">{rpmAriaLabel(lv?.rpm, lv?.rpmSource)}</span>
              </div>
              <div className="small muted">
                {FAN_MODE_LABELS[f.mode]} · {hardwareLabel(f.assignedHardware, f.customHardwareLabel)}
              </div>
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
