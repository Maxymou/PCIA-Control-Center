import { useCallback, useEffect, useRef, useState } from 'react';
import type { FanCurve } from '../../types';
import { clampPoint, evalCurve, sortCurve, TEMP_MAX, TEMP_MIN } from '../../utils/curve';

const W = 560, H = 280;
const M = { l: 44, r: 16, t: 14, b: 30 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;

const x = (t: number) => M.l + ((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * PW;
const y = (p: number) => M.t + (1 - p / 100) * PH;
const xInv = (px: number) => TEMP_MIN + ((px - M.l) / PW) * (TEMP_MAX - TEMP_MIN);
const yInv = (py: number) => (1 - (py - M.t) / PH) * 100;

export function CurveEditor({ curve, currentTemp, currentRpm, onChange, onCommit }: {
  curve: FanCurve;
  currentTemp: number;
  currentRpm: number;
  /** Appelé en continu pendant le déplacement (application immédiate). */
  onChange: (c: FanCurve) => void;
  /** Appelé à la fin d'une interaction (sauvegarde différée). */
  onCommit: (c: FanCurve) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; temp: number; pwm: number } | null>(null);
  const curveRef = useRef(curve);
  curveRef.current = curve;

  const toLocal = useCallback((e: PointerEvent | React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const sx = W / r.width, sy = H / r.height;
    return { px: (e.clientX - r.left) * sx, py: (e.clientY - r.top) * sy };
  }, []);

  // Déplacement d'un point
  useEffect(() => {
    if (dragIdx === null) return;
    const move = (e: PointerEvent) => {
      const { px, py } = toLocal(e);
      const c = [...curveRef.current];
      const p = clampPoint(c, dragIdx, xInv(px), yInv(py));
      c[dragIdx] = p;
      onChange(c);
      setHover({ x: x(p.temp), y: y(p.pwm), temp: p.temp, pwm: p.pwm });
    };
    const up = () => {
      setDragIdx(null);
      setHover(null);
      onCommit(curveRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragIdx, onChange, onCommit, toLocal]);

  const addPoint = (e: React.MouseEvent) => {
    if (curve.length >= 6) return;
    const { px, py } = toLocal(e as unknown as React.PointerEvent);
    if (px < M.l || px > W - M.r || py < M.t || py > H - M.b) return;
    const temp = Math.round(xInv(px));
    const c = sortCurve([...curve, { temp, pwm: Math.round(Math.max(0, Math.min(100, yInv(py)))) }]);
    // Ré-impose la monotonie après insertion
    const idx = c.findIndex((p) => p.temp === temp);
    c[idx] = clampPoint(c, idx, c[idx].temp, c[idx].pwm);
    onChange(c);
    onCommit(c);
    setSelIdx(idx);
  };

  const removeSelected = () => {
    if (selIdx === null || curve.length <= 2) return;
    const c = curve.filter((_, i) => i !== selIdx);
    setSelIdx(null);
    onChange(c);
    onCommit(c);
  };

  const editSelected = (field: 'temp' | 'pwm', v: number) => {
    if (selIdx === null || Number.isNaN(v)) return;
    const c = [...curve];
    const p = clampPoint(c, selIdx, field === 'temp' ? v : c[selIdx].temp, field === 'pwm' ? v : c[selIdx].pwm);
    c[selIdx] = p;
    onChange(c);
    onCommit(c);
  };

  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.temp)} ${y(p.pwm)}`).join(' ');
  const curPwm = evalCurve(curve, currentTemp);
  const clampedT = Math.max(TEMP_MIN, Math.min(TEMP_MAX, currentTemp));

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Courbe de ventilation : température vers puissance PWM"
        onDoubleClick={addPoint}
      >
        {/* Zones thermiques */}
        <rect x={x(TEMP_MIN)} y={M.t} width={x(70) - x(TEMP_MIN)} height={PH} fill="var(--ok)" opacity="0.045" />
        <rect x={x(70)} y={M.t} width={x(85) - x(70)} height={PH} fill="var(--warn)" opacity="0.06" />
        <rect x={x(85)} y={M.t} width={x(TEMP_MAX) - x(85)} height={PH} fill="var(--crit)" opacity="0.07" />

        {/* Grille */}
        {[0, 25, 50, 75, 100].map((p) => (
          <g key={p}>
            <line x1={M.l} x2={W - M.r} y1={y(p)} y2={y(p)} stroke="var(--border)" strokeWidth="1" />
            <text x={M.l - 8} y={y(p) + 4} textAnchor="end" fontSize="10" fill="var(--text-3)">{p} %</text>
          </g>
        ))}
        {[20, 40, 60, 80, 100].map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={M.t} y2={H - M.b} stroke="var(--border)" strokeWidth="1" opacity="0.6" />
            <text x={x(t)} y={H - M.b + 16} textAnchor="middle" fontSize="10" fill="var(--text-3)">{t} °C</text>
          </g>
        ))}

        {/* Courbe */}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.2" />

        {/* Marqueur de fonctionnement actuel */}
        <line x1={x(clampedT)} x2={x(clampedT)} y1={M.t} y2={H - M.b} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="3 3" />
        <circle cx={x(clampedT)} cy={y(curPwm)} r="5.5" fill="var(--ok)" stroke="#0d1013" strokeWidth="1.5" />
        <text x={Math.min(x(clampedT) + 8, W - 120)} y={Math.max(y(curPwm) - 10, 16)} fontSize="10.5" fill="var(--text)" className="mono">
          {currentTemp.toFixed(1)} °C → {Math.round(curPwm)} % · {currentRpm} RPM
        </text>

        {/* Points */}
        {curve.map((p, i) => (
          <circle
            key={i}
            className="pt"
            cx={x(p.temp)} cy={y(p.pwm)} r={selIdx === i ? 8 : 6.5}
            fill={selIdx === i ? 'var(--accent)' : 'var(--card)'}
            stroke="var(--accent)" strokeWidth="2"
            tabIndex={0}
            aria-label={`Point ${i + 1} : ${p.temp} degrés, ${p.pwm} pour cent`}
            onPointerDown={(e) => { e.preventDefault(); setSelIdx(i); setDragIdx(i); }}
            onPointerEnter={() => dragIdx === null && setHover({ x: x(p.temp), y: y(p.pwm), temp: p.temp, pwm: p.pwm })}
            onPointerLeave={() => dragIdx === null && setHover(null)}
          />
        ))}

        {/* Infobulle */}
        {hover && (
          <g transform={`translate(${Math.min(hover.x + 10, W - 92)}, ${Math.max(hover.y - 34, 6)})`}>
            <rect width="84" height="24" rx="5" fill="#0c0e12" stroke="var(--border-strong)" />
            <text x="42" y="16" textAnchor="middle" fontSize="10.5" fill="var(--text)" className="mono">
              {hover.temp} °C · {hover.pwm} %
            </text>
          </g>
        )}
      </svg>

      <div className="row small" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <span className="muted">
          {curve.length}/6 points · double-clic pour ajouter · glisser pour déplacer
        </span>
        {selIdx !== null && curve[selIdx] && (
          <span className="row" style={{ marginLeft: 'auto' }}>
            <label className="row small muted">T°
              <input type="number" className="mono" style={{ width: 64 }} min={TEMP_MIN} max={TEMP_MAX}
                value={curve[selIdx].temp} onChange={(e) => editSelected('temp', Number(e.target.value))} />
            </label>
            <label className="row small muted">PWM
              <input type="number" className="mono" style={{ width: 64 }} min={0} max={100}
                value={curve[selIdx].pwm} onChange={(e) => editSelected('pwm', Number(e.target.value))} />
            </label>
            <button className="btn-sm" onClick={removeSelected} disabled={curve.length <= 2}
              data-tip={curve.length <= 2 ? 'Minimum 2 points' : 'Supprimer le point sélectionné'}>
              Supprimer le point
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
