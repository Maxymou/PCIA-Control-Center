import { useLiveStore } from '../../store/useLiveStore';
import { useConfigStore } from '../../store/useConfigStore';
import { useUiStore } from '../../store/useUiStore';
import type { FanId, HardwareId, Severity } from '../../types';

const SEV_COLOR: Record<Severity, string> = {
  normal: 'var(--ok)', warning: 'var(--warn)', critical: 'var(--crit)', unknown: 'var(--off)',
};

/** Représentation technique simplifiée : boîtier, carte mère, emplacements PCIe,
 *  sorties ventilateur et zones avant/arrière, avec les associations actuelles. */
export function HardwareSchema() {
  const hardware = useLiveStore((s) => s.snap.hardware);
  const fansLive = useLiveStore((s) => s.snap.fans);
  const fanConfigs = useConfigStore((s) => s.fanConfigs);
  const ui = useUiStore();

  const hw = (id: HardwareId) => hardware.find((h) => h.id === id);
  const live = (id: FanId) => fansLive.find((f) => f.id === id);
  const gtx = hw('gtx1080');

  const HwBox = ({ id, x, y, w, h, label }: { id: HardwareId; x: number; y: number; w: number; h: number; label?: string }) => {
    const item = hw(id);
    if (!item?.installed) return null;
    const sel = ui.selectedHardwareId === id;
    return (
      <g
        className="slot"
        role="button"
        tabIndex={0}
        aria-pressed={sel}
        aria-label={`${item.name}${item.metrics.temp !== undefined ? `, ${item.metrics.temp.toFixed(0)} degrés` : ''}`}
        onClick={() => ui.selectHardware(sel ? null : id)}
        // Un élément portant role="button" doit répondre à Entrée et à Espace,
        // sans quoi il est inutilisable au clavier malgré son tabIndex.
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ui.selectHardware(sel ? null : id);
          }
        }}
      >
        <rect x={x} y={y} width={w} height={h} rx="7"
          fill="var(--card)" stroke={sel ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth={sel ? 2 : 1.2} />
        <circle cx={x + 12} cy={y + h / 2} r="4" fill={SEV_COLOR[item.metrics.status]} />
        <text x={x + 22} y={y + h / 2 - 2} fontSize="11" fill="var(--text)" fontWeight="600">{label ?? item.name}</text>
        <text x={x + 22} y={y + h / 2 + 12} fontSize="10" fill="var(--text-2)" className="mono">
          {item.metrics.temp !== undefined ? `${item.metrics.temp.toFixed(0)} °C` : ''}
          {item.pcieSlot ? ` · ${item.pcieSlot}` : ''}
        </text>
      </g>
    );
  };

  const FanTag = ({ id, x, y }: { id: FanId; x: number; y: number }) => {
    const cfg = fanConfigs.find((f) => f.id === id)!;
    const lv = live(id);
    const sel = ui.selectedFanId === id;
    return (
      <g
        className="slot"
        role="button"
        tabIndex={0}
        aria-pressed={sel}
        aria-label={`${cfg.displayName}${lv ? `, ${lv.rpm} tours par minute` : ', vitesse indisponible'}`}
        onClick={() => ui.selectFan(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ui.selectFan(id);
          }
        }}
      >
        <rect x={x} y={y} width={104} height={30} rx="6"
          fill={sel ? 'var(--accent-bg)' : 'var(--bg-raised)'}
          stroke={sel ? 'var(--accent)' : 'var(--border)'} strokeWidth={sel ? 1.8 : 1} />
        <circle cx={x + 11} cy={y + 15} r="3.5" fill={SEV_COLOR[lv?.status ?? 'unknown']} />
        <text x={x + 20} y={y + 13} fontSize="9.5" fill="var(--text)" className="mono" fontWeight="600">{id}</text>
        <text x={x + 20} y={y + 24} fontSize="9" fill="var(--text-2)" className="mono">{lv ? `${lv.rpm} RPM` : '—'}</text>
      </g>
    );
  };

  // Liaisons sortie → matériel (positions fixes du schéma)
  const anchors: Record<string, { x: number; y: number }> = {
    CPU_FAN1: { x: 20, y: 65 }, SYS_FAN1: { x: 20, y: 105 }, SYS_FAN2: { x: 20, y: 145 },
    SYS_FAN3: { x: 20, y: 185 }, SYS_FAN4: { x: 20, y: 225 },
    cpu: { x: 190, y: 78 }, 'case-front': { x: 190, y: 330 }, 'case-rear': { x: 355, y: 330 },
    'v100-1': { x: 190, y: 150 }, 'v100-2': { x: 190, y: 196 }, gtx1080: { x: 190, y: 242 },
    nvme: { x: 355, y: 78 },
  };

  return (
    <div className="hw-schema card card-pad">
      <p className="card-title">Schéma matériel</p>
      <svg viewBox="0 0 520 375" role="img" aria-label="Schéma des associations matériel et ventilation">
        {/* Contour boîtier */}
        <rect x="6" y="8" width="508" height="360" rx="12" fill="none" stroke="var(--border)" strokeWidth="1.2" strokeDasharray="5 4" />
        <text x="18" y="28" fontSize="10" fill="var(--text-3)" letterSpacing="1.5">BOÎTIER</text>

        {/* Carte mère */}
        <rect x="150" y="46" width="356" height="266" rx="9" fill="var(--bg-raised)" stroke="var(--border)" />
        <text x="164" y="64" fontSize="9.5" fill="var(--text-3)" letterSpacing="1.2">CARTE MÈRE · SORTIES PWM</text>

        {/* Liaisons */}
        {fanConfigs.map((f) => {
          const a = anchors[f.id];
          const target = f.assignedHardware !== 'none' && f.assignedHardware !== 'custom'
            ? anchors[f.assignedHardware] : null;
          if (!a || !target) return null;
          if (f.assignedHardware === 'gtx1080' && !gtx?.installed) return null;
          return (
            <path key={f.id}
              d={`M ${a.x + 104} ${a.y + 15} C ${a.x + 140} ${a.y + 15}, ${target.x - 36} ${target.y + 18}, ${target.x} ${target.y + 18}`}
              fill="none" stroke={ui.selectedFanId === f.id ? 'var(--accent)' : 'var(--border-strong)'}
              strokeWidth={ui.selectedFanId === f.id ? 2 : 1.2} />
          );
        })}

        {/* Sorties ventilateur */}
        <FanTag id="CPU_FAN1" x={20} y={65} />
        <FanTag id="SYS_FAN1" x={20} y={105} />
        <FanTag id="SYS_FAN2" x={20} y={145} />
        <FanTag id="SYS_FAN3" x={20} y={185} />
        <FanTag id="SYS_FAN4" x={20} y={225} />

        {/* Matériel */}
        <HwBox id="cpu" x={190} y={70} w={140} h={38} />
        <HwBox id="nvme" x={355} y={70} w={136} h={38} />
        <HwBox id="v100-1" x={190} y={142} w={300} h={38} />
        <HwBox id="v100-2" x={190} y={188} w={300} h={38} />
        <HwBox id="gtx1080" x={190} y={234} w={300} h={38} />
        {!gtx?.installed && (
          <g>
            <rect x={190} y={234} width={300} height={38} rx="7" fill="none" stroke="var(--border)" strokeDasharray="4 4" />
            <text x={340} y={257} textAnchor="middle" fontSize="10" fill="var(--text-3)">PCIe 3 · libre</text>
          </g>
        )}

        {/* Zones boîtier */}
        <HwBox id="case-front" x={190} y={322} w={140} h={38} label="Boîtier avant" />
        <HwBox id="case-rear" x={355} y={322} w={136} h={38} label="Boîtier arrière" />
      </svg>
      <p className="small muted" style={{ margin: 'var(--sp-2) 0 0' }}>
        Sélectionnez une sortie ou un composant pour l’afficher en surbrillance
        dans l’inventaire et dans la section Ventilation.
      </p>

      {/* Alternative textuelle : le schéma est une image, son contenu doit être
          accessible autrement qu'en le regardant. */}
      <details className="small" style={{ marginTop: 'var(--sp-2)' }}>
        <summary>Description textuelle des attributions</summary>
        <ul style={{ margin: 'var(--sp-2) 0 0', paddingLeft: '1.1rem' }}>
          {fanConfigs.map((f) => {
            const lv = live(f.id);
            const target = f.assignedHardware === 'custom'
              ? (f.customHardwareLabel ?? 'matériel personnalisé')
              : f.assignedHardware === 'none'
                ? 'aucun matériel'
                : (hw(f.assignedHardware)?.name ?? f.assignedHardware);
            return (
              <li key={f.id}>
                <b className="mono">{f.id}</b> ({f.displayName}) → {target}
                {lv ? ` — ${lv.pwm} %, ${lv.rpm} RPM` : ' — état indisponible'}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
