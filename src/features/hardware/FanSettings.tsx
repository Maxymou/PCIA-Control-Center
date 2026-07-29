import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '../../store/useConfigStore';
import { useLiveStore } from '../../store/useLiveStore';
import { useUiStore } from '../../store/useUiStore';
import { dataService } from '../../services/dataService';
import { seedProfiles } from '../../mocks/seed';
import type { FanCurve, FanMode, HardwareId, SensorRef } from '../../types';
import { FAN_MODE_LABELS } from '../../utils/labels';
import { CurveEditor } from './CurveEditor';
import { StatusDot } from '../../components/Common';

const SENSOR_SOURCES: { id: HardwareId; label: string }[] = [
  { id: 'cpu', label: 'Température CPU' },
  { id: 'v100-1', label: 'Température Tesla V100 n°1' },
  { id: 'v100-2', label: 'Température Tesla V100 n°2' },
  { id: 'gtx1080', label: 'Température GTX 1080' },
  { id: 'nvme', label: 'Température NVMe' },
  { id: 'motherboard', label: 'Température carte mère (simulée)' },
];

const ASSIGN_OPTIONS: { id: HardwareId | 'none' | 'custom'; label: string }[] = [
  { id: 'none', label: 'Aucun' },
  { id: 'cpu', label: 'CPU' },
  { id: 'case-front', label: 'Boîtier avant' },
  { id: 'case-rear', label: 'Boîtier arrière' },
  { id: 'v100-1', label: 'Tesla V100 n°1' },
  { id: 'v100-2', label: 'Tesla V100 n°2' },
  { id: 'gtx1080', label: 'GTX 1080' },
  { id: 'nvme', label: 'SSD NVMe' },
  { id: 'custom', label: 'Matériel personnalisé…' },
];

export function FanSettings() {
  const cfg = useConfigStore();
  const fanId = useUiStore((s) => s.selectedFanId);
  const live = useLiveStore((s) => s.snap.fans.find((f) => f.id === fanId));
  const gtxInstalled = useLiveStore((s) => s.snap.hardware.find((h) => h.id === 'gtx1080')?.installed ?? false);
  const fan = cfg.fanConfigs.find((f) => f.id === fanId);

  // Historique local de la courbe pour « annuler la dernière modification »
  const curveHistory = useRef<FanCurve[]>([]);
  const sessionStart = useRef<FanCurve | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    curveHistory.current = [];
    sessionStart.current = fan ? structuredClone(fan.curve) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fanId]);

  // Fin du test : retour automatique en mode courbe
  useEffect(() => {
    if (fan && fan.mode === 'test' && live && live.testRemaining === 0) {
      cfg.updateFan(fan.id, { mode: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.testRemaining]);

  if (!fan || !live) return null;

  const setMode = (mode: FanMode) => {
    if (mode === 'test') {
      cfg.updateFan(fan.id, { mode });
      dataService.startFanTest(fan.id, 30);
      dataService.logEvent({ category: 'fan', level: 'normal', targetLabel: fan.displayName, message: 'Test temporaire démarré (30 s à 100 %)' });
    } else {
      cfg.updateFan(fan.id, { mode });
    }
  };

  const setSensor = (v: string) => {
    let sensor: SensorRef;
    if (v === 'hottest-gpu') sensor = { kind: 'hottest-gpu' };
    else if (v === 'max' || v === 'avg') {
      const prev = fan.sensor;
      const sources = (prev.kind === 'max' || prev.kind === 'avg') && prev.sources.length
        ? prev.sources : (['cpu', 'v100-1', 'v100-2'] as HardwareId[]);
      sensor = { kind: v, sources };
    } else sensor = { kind: 'single', source: v as HardwareId };
    cfg.updateFan(fan.id, { sensor });
  };

  const toggleSensorSource = (id: HardwareId) => {
    if (fan.sensor.kind !== 'max' && fan.sensor.kind !== 'avg') return;
    const cur = fan.sensor.sources;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (next.length === 0) return;
    cfg.updateFan(fan.id, { sensor: { ...fan.sensor, sources: next } });
  };

  // Édition de courbe : application immédiate + historique local
  const onCurveChange = (c: FanCurve) => {
    // Application immédiate : updateFan pousse aussi la config vers la simulation
    cfg.updateFan(fan.id, { curve: c });
  };
  const onCurveCommit = (c: FanCurve) => {
    curveHistory.current.push(structuredClone(fan.curve));
    cfg.setCurve(fan.id, c);
    dataService.logEvent({ category: 'curve', level: 'normal', targetLabel: fan.displayName, message: 'Courbe de ventilation modifiée' });
    force((x) => x + 1);
  };
  const undoCurve = () => {
    const prev = curveHistory.current.pop();
    if (prev) { cfg.setCurve(fan.id, prev); force((x) => x + 1); }
  };
  const restoreSessionCurve = () => {
    if (sessionStart.current) cfg.setCurve(fan.id, structuredClone(sessionStart.current));
  };
  const restoreProfileCurve = () => {
    const all = [...seedProfiles, ...cfg.customProfiles];
    const p = all.find((x) => x.id === cfg.activeProfileId);
    if (p) cfg.setCurve(fan.id, structuredClone(p.curves[fan.id]));
  };

  const sensorValue = fan.sensor.kind === 'single' ? fan.sensor.source : fan.sensor.kind;
  const allProfiles = [...seedProfiles, ...cfg.customProfiles];

  return (
    <div className="card card-pad">
      <div className="spread">
        <div className="row">
          <StatusDot sev={live.status} pulse={live.status === 'critical'} />
          <strong>{fan.displayName}</strong>
          <span className="muted small mono">{fan.id}</span>
        </div>
        <span className="mono small">
          {live.pwm} % · {live.rpm} RPM · réf. {live.refTemp.toFixed(1)} °C
        </span>
      </div>

      <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: 1 }}>Nom d’affichage
          <input key={fan.id} defaultValue={fan.displayName}
            onBlur={(e) => e.target.value.trim() && cfg.updateFan(fan.id, { displayName: e.target.value.trim() })} />
        </label>
        <label className="field" style={{ flex: 1 }}>Mode
          <select value={fan.mode} onChange={(e) => setMode(e.target.value as FanMode)}>
            {Object.entries(FAN_MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>

      {fan.mode === 'manual' && (
        <label className="field" style={{ marginTop: 8 }}>
          Consigne manuelle : <b className="mono">{fan.manualPwm} %</b>
          <input type="range" min={0} max={100} value={fan.manualPwm}
            onChange={(e) => cfg.updateFan(fan.id, { manualPwm: Number(e.target.value) })} />
        </label>
      )}
      {fan.mode === 'full' && (
        <div className="small muted" style={{ marginTop: 8 }}>Consigne forcée à <b className="mono">100 %</b>.</div>
      )}
      {fan.mode === 'test' && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="badge accent">Test en cours</span>
          <span className="mono">{Math.ceil(live.testRemaining ?? 0)} s restantes à 100 %</span>
          <button className="btn-sm" onClick={() => { dataService.stopFanTest(fan.id); cfg.updateFan(fan.id, { mode: 'auto' }); }}>
            Arrêter le test
          </button>
        </div>
      )}

      <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: 1 }} data-tip="Destination physique du ventilateur">
          Matériel attribué
          <select value={fan.assignedHardware}
            onChange={(e) => cfg.updateFan(fan.id, { assignedHardware: e.target.value as HardwareId | 'none' | 'custom' })}>
            {ASSIGN_OPTIONS.filter((o) => o.id !== 'gtx1080' || gtxInstalled).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }} data-tip="Température pilotant la courbe — indépendante du matériel attribué">
          Capteur de référence
          <select value={sensorValue} onChange={(e) => setSensor(e.target.value)}>
            {SENSOR_SOURCES.filter((s) => s.id !== 'gtx1080' || gtxInstalled).map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
            <option value="hottest-gpu">GPU le plus chaud</option>
            <option value="max">Maximum de plusieurs capteurs</option>
            <option value="avg">Moyenne de plusieurs capteurs</option>
          </select>
        </label>
      </div>
      {fan.assignedHardware === 'custom' && (
        <label className="field" style={{ marginTop: 6 }}>Libellé du matériel personnalisé
          <input value={fan.customHardwareLabel ?? ''} placeholder="ex. Radiateur AIO"
            onChange={(e) => cfg.updateFan(fan.id, { customHardwareLabel: e.target.value })} />
        </label>
      )}
      {(fan.sensor.kind === 'max' || fan.sensor.kind === 'avg') && (
        <div className="row small" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <span className="muted">Capteurs combinés :</span>
          {SENSOR_SOURCES.filter((s) => s.id !== 'gtx1080' || gtxInstalled).map((s) => (
            <label key={s.id} className="row small" style={{ cursor: 'pointer' }}>
              <input type="checkbox"
                checked={(fan.sensor as { sources: HardwareId[] }).sources.includes(s.id)}
                onChange={() => toggleSensorSource(s.id)} />
              {s.label.replace('Température ', '')}
            </label>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 10, gap: 12 }}>
        <label className="field" style={{ width: 150 }}>Seuil minimum (PWM)
          <input type="number" className="mono" min={0} max={50} value={fan.minPwm}
            onChange={(e) => cfg.updateFan(fan.id, { minPwm: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} />
        </label>
        <label className="field" style={{ width: 170 }}>Seuil d’alerte (RPM min.)
          <input type="number" className="mono" min={0} value={fan.warnRpm}
            onChange={(e) => cfg.updateFan(fan.id, { warnRpm: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label className="field" style={{ flex: 1 }}>Appliquer un profil à cette sortie
          <select value="" onChange={(e) => { if (e.target.value) cfg.applyProfile(e.target.value, fan.id); }}>
            <option value="">Choisir…</option>
            {allProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>

      <div className="divider" />
      <p className="card-title">Courbe de ventilation {fan.mode !== 'auto' && <span className="muted">(active en mode automatique)</span>}</p>
      <CurveEditor
        curve={fan.curve}
        currentTemp={live.refTemp}
        currentRpm={live.rpm}
        onChange={onCurveChange}
        onCommit={onCurveCommit}
      />
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn-sm" onClick={undoCurve} disabled={curveHistory.current.length === 0}>
          Annuler la dernière modification
        </button>
        <button className="btn-sm" onClick={restoreSessionCurve}>Restaurer la courbe précédente</button>
        <button className="btn-sm" onClick={restoreProfileCurve}>Restaurer la courbe du profil</button>
        <button className="btn-sm" onClick={() => setMode('full')}>Forcer 100 %</button>
      </div>
    </div>
  );
}
