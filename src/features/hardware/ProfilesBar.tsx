import { useState } from 'react';
import { useConfigStore } from '../../store/useConfigStore';
import { seedProfiles } from '../../mocks/seed';
import { dataService } from '../../services/dataService';
import type { FanProfile } from '../../types';
import { Confirm, Modal } from '../../components/Common';

/** Mini-aperçu des courbes d'un profil. */
function ProfilePreview({ p }: { p: FanProfile }) {
  const curves = Object.values(p.curves);
  return (
    <svg viewBox="0 0 80 36" width="80" height="36" aria-hidden style={{ flex: 'none' }}>
      <rect x="0" y="0" width="80" height="36" rx="5" fill="var(--bg-raised)" stroke="var(--border)" />
      {curves.slice(0, 5).map((c, i) => (
        <path key={i} fill="none" stroke="var(--accent)" strokeWidth="1" opacity={0.35 + i * 0.12}
          d={c.map((pt, j) => `${j === 0 ? 'M' : 'L'} ${4 + ((pt.temp - 20) / 80) * 72} ${32 - (pt.pwm / 100) * 28}`).join(' ')} />
      ))}
    </svg>
  );
}

export function ProfilesBar() {
  const cfg = useConfigStore();
  const all = [...seedProfiles, ...cfg.customProfiles];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [name, setName] = useState('');

  const apply = (id: string) => {
    cfg.applyProfile(id);
    const p = all.find((x) => x.id === id);
    dataService.addProfileMarker(`Profil : ${p?.name ?? id}`);
    dataService.logEvent({ category: 'profile', level: 'normal', targetLabel: p?.name ?? id, message: 'Changement de profil de ventilation' });
  };

  return (
    <div className="card card-pad">
      <div className="spread">
        <p className="card-title" style={{ margin: 0 }}>Profils de ventilation</p>
        <div className="row">
          <button className="btn-sm" onClick={() => { setName(''); setCreating(true); }}>Créer un profil</button>
          <button className="btn-sm" onClick={() => cfg.duplicateProfile(cfg.activeProfileId)}>Dupliquer l’actif</button>
          <button className="btn-sm" onClick={cfg.restoreBuiltinProfiles} data-tip="Réapplique les courbes d'origine du profil prédéfini actif">
            Restaurer les prédéfinis
          </button>
        </div>
      </div>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8, alignItems: 'stretch' }}>
        {all.map((p) => {
          const active = p.id === cfg.activeProfileId;
          const deletable = !p.builtin && p.id !== 'p-custom';
          return (
            <div key={p.id} className="card" style={{
              padding: '8px 10px', display: 'flex', gap: 10, alignItems: 'center',
              borderColor: active ? 'var(--accent)' : undefined, minWidth: 210,
            }}>
              <ProfilePreview p={p} />
              <div className="col" style={{ gap: 4 }}>
                <div className="row">
                  <strong className="small">{p.name}</strong>
                  {active && <span className="badge accent">Actif</span>}
                  {p.builtin && <span className="badge outline">Prédéfini</span>}
                </div>
                <div className="row">
                  {!active && <button className="btn-sm btn-primary" onClick={() => apply(p.id)}>Appliquer à tout</button>}
                  {!p.builtin && (
                    <button className="btn-sm btn-ghost" onClick={() => { setRenaming(p.id); setName(p.name); }}>Renommer</button>
                  )}
                  {deletable && (
                    <button className="btn-sm btn-ghost" style={{ color: 'var(--crit)' }} onClick={() => setConfirmDel(p.id)}>Supprimer</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {(creating || renaming) && (
        <Modal title={creating ? 'Créer un profil personnalisé' : 'Renommer le profil'} onClose={() => { setCreating(false); setRenaming(null); }}>
          <div className="col">
            <label className="field">Nom du profil
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                placeholder="ex. Nuit silencieuse" />
            </label>
            {creating && <p className="small muted" style={{ margin: 0 }}>Le profil est créé à partir des courbes actuelles des cinq sorties.</p>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => { setCreating(false); setRenaming(null); }}>Annuler</button>
              <button className="btn-primary" disabled={!name.trim()} onClick={() => {
                if (creating) cfg.createCustomProfile(name.trim());
                else if (renaming) cfg.renameProfile(renaming, name.trim());
                setCreating(false); setRenaming(null);
              }}>
                {creating ? 'Créer le profil' : 'Renommer'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmDel && (
        <Confirm
          message={`Supprimer le profil « ${all.find((p) => p.id === confirmDel)?.name} » ?`}
          confirmLabel="Supprimer"
          onConfirm={() => { cfg.deleteProfile(confirmDel); setConfirmDel(null); }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}
