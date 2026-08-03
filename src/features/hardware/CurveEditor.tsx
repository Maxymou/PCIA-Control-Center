/** Éditeur de courbe de ventilation.
 *
 *  Trois modes de saisie, tous équivalents — aucun n'est un repli dégradé :
 *
 *   souris   glisser un point, double-clic pour en ajouter ;
 *   tactile  glisser un point au doigt (`touch-action: none` sur le SVG, sans
 *            quoi le geste ferait défiler la page), puis réglage précis par
 *            champs numériques — indispensable, viser un degré au doigt n'est
 *            pas réaliste ;
 *   clavier  Tab pour passer d'un point à l'autre, flèches pour déplacer (Maj
 *            pour un pas de 5), Suppr pour retirer.
 *
 *  La logique de contrainte (`clampPoint`) reste celle qui existait : le
 *  front-end n'invente aucune règle de courbe, et le serveur revalide de toute
 *  façon avant d'appliquer quoi que ce soit au matériel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FanCurve } from '../../types';
import { clampPoint, evalCurve, sortCurve, TEMP_MAX, TEMP_MIN } from '../../utils/curve';
import { Tooltip } from '../../ui/Tooltip';

const W = 560, H = 280;
const M = { l: 44, r: 16, t: 14, b: 30 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
/** Nombre maximal de points, aligné sur la validation du serveur. */
const MAX_POINTS = 6;

const x = (t: number) => M.l + ((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * PW;
const y = (p: number) => M.t + (1 - p / 100) * PH;
const xInv = (px: number) => TEMP_MIN + ((px - M.l) / PW) * (TEMP_MAX - TEMP_MIN);
const yInv = (py: number) => (1 - (py - M.t) / PH) * 100;

export function CurveEditor({ curve, currentTemp, currentRpm, onChange, onCommit, disabled = false }: {
  curve: FanCurve;
  currentTemp: number;
  currentRpm: number;
  /** Appelé en continu pendant le déplacement (application immédiate). */
  onChange: (c: FanCurve) => void;
  /** Appelé à la fin d'une interaction (sauvegarde différée). */
  onCommit: (c: FanCurve) => void;
  /** Édition refusée : liaison perdue, capacité absente ou moteur hors ligne. */
  disabled?: boolean;
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

  // Déplacement d'un point. `pointermove` couvre souris, stylet et doigt : un
  // seul chemin de code, donc un seul comportement à vérifier.
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
    // `pointercancel` : un geste interrompu par le système (appel entrant,
    // geste de navigation iOS) doit terminer proprement, pas laisser un point
    // collé au doigt.
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragIdx, onChange, onCommit, toLocal]);

  const addPoint = (e: React.MouseEvent) => {
    if (disabled || curve.length >= MAX_POINTS) return;
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

  /** Ajoute un point au milieu du plus large intervalle — équivalent tactile et
   *  clavier du double-clic, qui n'existe ni au doigt ni au clavier. */
  const addPointAuto = () => {
    if (disabled || curve.length >= MAX_POINTS) return;
    let bestGap = -1, bestIdx = 0;
    for (let i = 0; i < curve.length - 1; i++) {
      const gap = curve[i + 1].temp - curve[i].temp;
      if (gap > bestGap) { bestGap = gap; bestIdx = i; }
    }
    if (bestGap < 2) return;
    const temp = Math.round((curve[bestIdx].temp + curve[bestIdx + 1].temp) / 2);
    const pwm = Math.round(evalCurve(curve, temp));
    const c = sortCurve([...curve, { temp, pwm }]);
    const idx = c.findIndex((p) => p.temp === temp);
    c[idx] = clampPoint(c, idx, c[idx].temp, c[idx].pwm);
    onChange(c);
    onCommit(c);
    setSelIdx(idx);
  };

  const removeSelected = () => {
    if (disabled || selIdx === null || curve.length <= 2) return;
    const c = curve.filter((_, i) => i !== selIdx);
    setSelIdx(null);
    onChange(c);
    onCommit(c);
  };

  const editSelected = (field: 'temp' | 'pwm', v: number) => {
    if (disabled || selIdx === null || Number.isNaN(v)) return;
    const c = [...curve];
    const p = clampPoint(c, selIdx, field === 'temp' ? v : c[selIdx].temp, field === 'pwm' ? v : c[selIdx].pwm);
    c[selIdx] = p;
    onChange(c);
    onCommit(c);
  };

  /** Saisie en cours dans les champs numériques.
   *
   *  Sans ce brouillon, la contrainte s'appliquerait à chaque frappe : taper
   *  « 70 » dans un champ affichant 60 donnerait d'abord 7 — aussitôt ramené au
   *  minimum autorisé — puis 310, ramené au maximum. Le champ combattrait
   *  l'utilisateur au lieu de le laisser saisir. La valeur n'est donc contrainte
   *  et appliquée qu'à la validation : perte de focus ou touche Entrée. */
  const [draft, setDraft] = useState<{ field: 'temp' | 'pwm'; value: string } | null>(null);

  const fieldValue = (field: 'temp' | 'pwm'): string => {
    if (draft?.field === field) return draft.value;
    if (selIdx === null || !curve[selIdx]) return '';
    return String(curve[selIdx][field]);
  };

  const commitDraft = () => {
    if (!draft) return;
    const value = Number(draft.value);
    setDraft(null);
    if (draft.value.trim() === '' || Number.isNaN(value)) return;
    editSelected(draft.field, value);
  };

  /** Déplacement au clavier du point focalisé. */
  const onPointKeyDown = (index: number) => (e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = e.shiftKey ? 5 : 1;
    const point = curve[index];
    let temp = point.temp;
    let pwm = point.pwm;

    switch (e.key) {
      case 'ArrowLeft': temp -= step; break;
      case 'ArrowRight': temp += step; break;
      case 'ArrowUp': pwm += step; break;
      case 'ArrowDown': pwm -= step; break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        setSelIdx(index);
        removeSelected();
        return;
      default:
        return;
    }
    e.preventDefault();
    const c = [...curve];
    c[index] = clampPoint(c, index, temp, pwm);
    setSelIdx(index);
    onChange(c);
    onCommit(c);
  };

  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.temp)} ${y(p.pwm)}`).join(' ');
  const curPwm = evalCurve(curve, currentTemp);
  const clampedT = Math.max(TEMP_MIN, Math.min(TEMP_MAX, currentTemp));

  /** Description textuelle : le graphique n'est pas la seule façon de lire la
   *  courbe, et un lecteur d'écran doit pouvoir l'énoncer. */
  const summary = curve.map((p) => `${p.temp} °C → ${p.pwm} %`).join(' ; ');

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        // `role="group"` et non `role="img"` : les points sont focalisables, et
        // une image ne peut pas contenir de contrôles. Le résumé textuel affiché
        // sous le graphique tient lieu d'alternative.
        role="group"
        aria-label={`Courbe de ventilation : ${summary}. Fonctionnement actuel : ${currentTemp.toFixed(1)} degrés, ${Math.round(curPwm)} pour cent.`}
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
        <circle cx={x(clampedT)} cy={y(curPwm)} r="5.5" fill="var(--ok)" stroke="var(--surface-sunken)" strokeWidth="1.5" />
        <text x={Math.min(x(clampedT) + 8, W - 120)} y={Math.max(y(curPwm) - 10, 16)} fontSize="10.5" fill="var(--text)" className="mono">
          {currentTemp.toFixed(1)} °C → {Math.round(curPwm)} % · {currentRpm} RPM
        </text>

        {/* Points. La cible de saisie invisible est bien plus large que le
            disque : au doigt, viser un cercle de 6,5 px est impossible. */}
        {curve.map((p, i) => (
          <g key={i}>
            <circle
              className="pt-hit"
              cx={x(p.temp)} cy={y(p.pwm)} r="18"
              fill="transparent"
              onPointerDown={(e) => {
                if (disabled) return;
                e.preventDefault();
                setSelIdx(i);
                setDragIdx(i);
              }}
            />
            <circle
              className="pt"
              cx={x(p.temp)} cy={y(p.pwm)} r={selIdx === i ? 8 : 6.5}
              fill={selIdx === i ? 'var(--accent)' : 'var(--card)'}
              stroke="var(--accent)" strokeWidth="2"
              tabIndex={disabled ? -1 : 0}
              role="button"
              aria-label={`Point ${i + 1} sur ${curve.length} : ${p.temp} degrés, ${p.pwm} pour cent. Flèches pour déplacer, Maj pour un pas de 5, Suppr pour retirer.`}
              onFocus={() => setSelIdx(i)}
              onKeyDown={onPointKeyDown(i)}
              onPointerEnter={() => dragIdx === null && setHover({ x: x(p.temp), y: y(p.pwm), temp: p.temp, pwm: p.pwm })}
              onPointerLeave={() => dragIdx === null && setHover(null)}
            />
          </g>
        ))}

        {/* Infobulle de glissement — interne au SVG, donc toujours dans le cadre. */}
        {hover && (
          <g transform={`translate(${Math.min(hover.x + 10, W - 92)}, ${Math.max(hover.y - 34, 6)})`}>
            <rect width="84" height="24" rx="5" fill="var(--surface-sunken)" stroke="var(--border-strong)" />
            <text x="42" y="16" textAnchor="middle" fontSize="10.5" fill="var(--text)" className="mono">
              {hover.temp} °C · {hover.pwm} %
            </text>
          </g>
        )}
      </svg>

      {/* Résumé lisible sans interpréter le graphique. */}
      <p className="small muted" style={{ margin: 'var(--sp-2) 0 0' }}>
        {curve.length}/{MAX_POINTS} points — {summary}
      </p>

      {/* Réglage précis. Sur mobile, c'est le moyen principal ; sur poste de
          travail, il complète le glissement. */}
      <div className="curve-point-editor" style={{ marginTop: 'var(--sp-2)' }}>
        <label className="field">
          Point
          <select
            value={selIdx ?? ''}
            onChange={(e) => {
              setDraft(null);
              setSelIdx(e.target.value === '' ? null : Number(e.target.value));
            }}
          >
            <option value="">Aucun</option>
            {curve.map((p, i) => (
              <option key={i} value={i}>{i + 1} — {p.temp} °C / {p.pwm} %</option>
            ))}
          </select>
        </label>

        <label className="field">
          Température
          <input
            type="number" className="mono" inputMode="numeric"
            min={TEMP_MIN} max={TEMP_MAX}
            disabled={disabled || selIdx === null}
            value={fieldValue('temp')}
            onChange={(e) => setDraft({ field: 'temp', value: e.target.value })}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } }}
          />
        </label>

        <label className="field">
          Consigne
          <input
            type="number" className="mono" inputMode="numeric"
            min={0} max={100}
            disabled={disabled || selIdx === null}
            value={fieldValue('pwm')}
            onChange={(e) => setDraft({ field: 'pwm', value: e.target.value })}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } }}
          />
        </label>

        <Tooltip content={curve.length >= MAX_POINTS
          ? `Une courbe comporte au maximum ${MAX_POINTS} points`
          : 'Ajoute un point au milieu du plus large intervalle'}>
          <button type="button" className="btn-sm" onClick={addPointAuto}
            disabled={disabled || curve.length >= MAX_POINTS}>
            Ajouter un point
          </button>
        </Tooltip>

        <Tooltip content={curve.length <= 2
          ? 'Une courbe comporte au minimum deux points'
          : 'Supprimer le point sélectionné'}>
          <button type="button" className="btn-sm" onClick={removeSelected}
            disabled={disabled || selIdx === null || curve.length <= 2}>
            Supprimer le point
          </button>
        </Tooltip>
      </div>

      <p className="small muted" style={{ margin: 'var(--sp-2) 0 0' }}>
        Souris : glisser un point, double-clic pour en ajouter. Tactile : glisser
        un point, puis ajuster au champ. Clavier : Tab pour choisir un point,
        flèches pour le déplacer (Maj = pas de 5), Suppr pour le retirer.
      </p>
    </div>
  );
}
