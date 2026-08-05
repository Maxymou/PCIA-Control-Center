import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '../../store/useConfigStore';
import { useLiveStore } from '../../store/useLiveStore';
import { useUiStore } from '../../store/useUiStore';
import { dataService } from '../../services/dataService';
import type { FanCurve, FanMode, HardwareId, SensorRef } from '../../types';
import { FAN_MODE_LABELS } from '../../utils/labels';
import { fmtRpm } from '../../utils/format';
import { CurveEditor } from './CurveEditor';
import { StatusDot } from '../../components/Common';
import { HelpTip } from '../../ui/Tooltip';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useConnectionState } from '../../ui/useConnectionState';
import { CalibrationWizard } from './CalibrationWizard';

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

/** Consignes de sécurité propres à chaque mode, énoncées avant confirmation. */
const MODE_CONSEQUENCES: Record<FanMode, string[]> = {
  auto: [
    'La sortie suit à nouveau sa courbe et son capteur de référence.',
    'Les sécurités du moteur restent actives : plancher des cartes passives, consigne de secours en cas de perte de capteur, détection de blocage.',
  ],
  manual: [
    'La courbe cesse de s’appliquer : la consigne devient fixe et ne suivra plus la température.',
    'En cas de montée en charge, la ventilation n’augmentera pas d’elle-même.',
    'Le plancher des sorties de cartes passives reste imposé par le moteur, quelle que soit la consigne demandée.',
    'Les sécurités thermiques du moteur restent actives et peuvent forcer la sortie à 100 %.',
  ],
  full: [
    'La sortie est forcée à 100 % en continu, jusqu’à annulation explicite.',
    'Le bruit sera maximal ; l’usure du ventilateur est accélérée.',
    'La courbe et le capteur de référence sont ignorés tant que ce mode est actif.',
  ],
  test: [
    'La sortie passe à 100 % pendant 30 secondes, puis revient automatiquement en mode automatique.',
    'Sert à identifier physiquement un ventilateur ou à vérifier son retour tachymétrique.',
  ],
};

export function FanSettings() {
  const cfg = useConfigStore();
  const fanId = useUiStore((s) => s.selectedFanId);
  const live = useLiveStore((s) => s.snap.fans.find((f) => f.id === fanId));
  const gtxInstalled = useLiveStore((s) => s.snap.hardware.find((h) => h.id === 'gtx1080')?.installed ?? false);
  const fan = cfg.fanConfigs.find((f) => f.id === fanId);

  const link = useConnectionState();
  const [pendingMode, setPendingMode] = useState<FanMode | null>(null);
  const [showCalibration, setShowCalibration] = useState(false);
  /** Première modification de courbe de la session, par sortie : confirmée une
   *  fois, puis l'édition redevient fluide — une confirmation à chaque
   *  déplacement de point rendrait l'éditeur inutilisable. */
  const [pendingCurve, setPendingCurve] = useState<FanCurve | null>(null);
  const curveAcknowledged = useRef<Set<string>>(new Set());

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

  /** Applique réellement le mode. N'est appelée qu'après confirmation. */
  const applyMode = (mode: FanMode) => {
    if (mode === 'test') {
      cfg.updateFan(fan.id, { mode });
      dataService.startFanTest(fan.id, 30);
      dataService.logEvent({ category: 'fan', level: 'normal', targetLabel: fan.displayName, message: 'Test temporaire démarré (30 s à 100 %)' });
    } else {
      cfg.updateFan(fan.id, { mode });
    }
    setPendingMode(null);
  };

  /** Tout changement de mode passe par une confirmation : quitter le mode
   *  automatique retire la régulation par courbe, ce qui n'est pas anodin sur
   *  une machine dont les cartes sont refroidies passivement. Le retour au mode
   *  automatique est le seul à ne rien engager de dangereux. */
  const setMode = (mode: FanMode) => {
    if (mode === fan.mode) return;
    if (mode === 'auto') applyMode('auto');
    else setPendingMode(mode);
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
  /** Enregistre et pousse la courbe vers le serveur, qui la valide puis
   *  l'applique. Le comportement historique — application immédiate — est
   *  conservé tel quel : le moteur reste seul juge de ce qui est appliqué. */
  const commitCurve = (c: FanCurve) => {
    curveHistory.current.push(structuredClone(fan.curve));
    cfg.setCurve(fan.id, c);
    dataService.logEvent({ category: 'curve', level: 'normal', targetLabel: fan.displayName, message: 'Courbe de ventilation modifiée' });
    setPendingCurve(null);
    force((x) => x + 1);
  };

  const onCurveCommit = (c: FanCurve) => {
    // Une confirmation à chaque déplacement de point rendrait l'éditeur
    // inutilisable ; une seule, à la première modification de cette sortie dans
    // la session, suffit à ce que l'utilisateur sache ce qu'il engage.
    if (!curveAcknowledged.current.has(fan.id)) {
      setPendingCurve(c);
      return;
    }
    commitCurve(c);
  };
  const undoCurve = () => {
    const prev = curveHistory.current.pop();
    if (prev) { cfg.setCurve(fan.id, prev); force((x) => x + 1); }
  };
  const restoreSessionCurve = () => {
    if (sessionStart.current) cfg.setCurve(fan.id, structuredClone(sessionStart.current));
  };
  const restoreProfileCurve = () => {
    const all = [...cfg.builtinProfiles, ...cfg.customProfiles];
    const p = all.find((x) => x.id === cfg.activeProfileId);
    if (p) cfg.setCurve(fan.id, structuredClone(p.curves[fan.id]));
  };

  const sensorValue = fan.sensor.kind === 'single' ? fan.sensor.source : fan.sensor.kind;
  const allProfiles = [...cfg.builtinProfiles, ...cfg.customProfiles];

  return (
    <div className="card card-pad">
      <div className="spread">
        <div className="row">
          <StatusDot sev={live.status} pulse={live.status === 'critical'} />
          <strong>{fan.displayName}</strong>
          <span className="muted small mono">{fan.id}</span>
        </div>
        <span className="mono small">
          {live.pwm} % · {fmtRpm(live.rpm, live.rpmSource)} · réf. {live.refTemp.toFixed(1)} °C
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
        <label className="field" style={{ flex: 1 }}>
          <span className="row">
            Matériel attribué
            <HelpTip label="À quoi sert le matériel attribué ?">
              Destination physique du ventilateur. Sert à l’affichage et au schéma :
              c’est le capteur de référence, réglé à côté, qui pilote la courbe.
            </HelpTip>
          </span>
          <select value={fan.assignedHardware}
            onChange={(e) => cfg.updateFan(fan.id, { assignedHardware: e.target.value as HardwareId | 'none' | 'custom' })}>
            {ASSIGN_OPTIONS.filter((o) => o.id !== 'gtx1080' || gtxInstalled).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span className="row">
            Capteur de référence
            <HelpTip label="À quoi sert le capteur de référence ?">
              Température qui pilote la courbe de cette sortie. Elle est
              indépendante du matériel attribué : une sortie peut souffler sur la
              façade tout en suivant la température du GPU le plus chaud.
            </HelpTip>
          </span>
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
      <p className="card-title">
        Courbe de ventilation
        {fan.mode !== 'auto' && <span className="muted"> (active en mode automatique)</span>}
      </p>

      {/* Avertissement permanent : il ne se replie pas et ne se ferme pas. La
          personne qui édite une courbe doit avoir en permanence sous les yeux
          ce que le front-end ne garantit pas. */}
      <div className="banner banner--warning" style={{ marginBottom: 'var(--sp-3)' }}>
        <span aria-hidden="true">⚠</span>
        <div className="banner__body">
          <p className="banner__title">Cette courbe pilote un refroidissement réel</p>
          <p style={{ margin: 0 }}>
            Chaque modification est envoyée au serveur, qui la valide puis
            l’applique immédiatement. Les sécurités restent celles du moteur —
            plancher de 35 % sur les sorties des Tesla V100 passives, consigne de
            secours en cas de perte de capteur, passage à 100 % au-delà de 90 °C.
            L’interface ne les remplace pas et ne peut pas les contourner.
          </p>
        </div>
      </div>

      <CurveEditor
        curve={fan.curve}
        currentTemp={live.refTemp}
        currentRpm={live.rpm}
        currentRpmSource={live.rpmSource}
        onChange={onCurveChange}
        onCommit={onCurveCommit}
        disabled={!link.commandsEnabled}
      />
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn-sm" onClick={undoCurve} disabled={curveHistory.current.length === 0}>
          Annuler la dernière modification
        </button>
        <button className="btn-sm" onClick={restoreSessionCurve}>Restaurer la courbe précédente</button>
        <button className="btn-sm" onClick={restoreProfileCurve}>Restaurer la courbe du profil</button>
        <button className="btn-sm" onClick={() => setMode('full')}>Forcer 100 %</button>
      </div>

      <div className="divider" />
      <div className="row row-wrap">
        <button type="button" onClick={() => setShowCalibration(true)}>
          Ouvrir l’assistant de calibration
        </button>
        <span className="small muted">
          Identifie physiquement le ventilateur, valide son retour tachymétrique
          et la restitution au BIOS. Chaque étape agit sur le matériel.
        </span>
      </div>

      {pendingMode && (
        <ConfirmDialog
          action={`Passer en mode : ${FAN_MODE_LABELS[pendingMode]}`}
          target={`${fan.displayName} (${fan.id})`}
          consequences={MODE_CONSEQUENCES[pendingMode]}
          reversible="Réversible : le retour au mode automatique rétablit la régulation par courbe."
          confirmLabel={`Passer en ${FAN_MODE_LABELS[pendingMode].toLowerCase()}`}
          destructive={pendingMode === 'full' || pendingMode === 'manual'}
          blockedReason={link.commandsEnabled ? null : link.blockedReason}
          onConfirm={() => applyMode(pendingMode)}
          onCancel={() => setPendingMode(null)}
        />
      )}

      {pendingCurve && (
        <ConfirmDialog
          action="Modifier la courbe de ventilation"
          target={`${fan.displayName} (${fan.id})`}
          consequences={[
            'La nouvelle courbe est envoyée au serveur, qui la valide puis l’applique immédiatement.',
            'Une courbe refusée par le serveur est ignorée : la précédente reste appliquée.',
            'Les sécurités du moteur restent prioritaires sur la courbe, y compris le plancher des sorties de cartes passives.',
            'Cette confirmation n’est demandée qu’une fois par sortie et par session : les réglages suivants seront appliqués directement.',
          ]}
          reversible="Réversible : « Annuler la dernière modification » et « Restaurer la courbe du profil » rétablissent la courbe précédente."
          confirmLabel="Appliquer la courbe"
          blockedReason={link.commandsEnabled ? null : link.blockedReason}
          onConfirm={() => {
            curveAcknowledged.current.add(fan.id);
            commitCurve(pendingCurve);
          }}
          onCancel={() => {
            // Refus : on remet la courbe précédente, celle que le serveur
            // applique réellement.
            setPendingCurve(null);
            const previous = sessionStart.current;
            if (previous) cfg.updateFan(fan.id, { curve: structuredClone(previous) });
          }}
        />
      )}

      {showCalibration && (
        <CalibrationWizard
          fanId={fan.id}
          displayName={fan.displayName}
          onClose={() => setShowCalibration(false)}
        />
      )}
    </div>
  );
}
