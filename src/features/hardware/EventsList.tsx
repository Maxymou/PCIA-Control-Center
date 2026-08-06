import { useState } from 'react';
import { useLiveStore } from '../../store/useLiveStore';
import { EVENT_CATEGORY_LABELS } from '../../utils/labels';
import { fmtTime } from '../../utils/format';
import { StatusDot } from '../../components/Common';
import type { EventCategory, Severity } from '../../types';

export function EventsList() {
  const events = useLiveStore((s) => s.snap.events);
  const [cat, setCat] = useState<EventCategory | ''>('');
  const [level, setLevel] = useState<Severity | ''>('');
  const [search, setSearch] = useState('');
  const [periodMin, setPeriodMin] = useState(60);

  const cutoff = Date.now() - periodMin * 60_000;
  const shown = events.filter((e) =>
    e.time >= cutoff
    && (!cat || e.category === cat)
    && (!level || e.level === level)
    && (!search || e.targetLabel.toLowerCase().includes(search.toLowerCase()) || e.message.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="card card-pad">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="card-title" style={{ margin: 0 }}>Événements récents</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={cat} onChange={(e) => setCat(e.target.value as EventCategory | '')} aria-label="Catégorie">
            <option value="">Toutes catégories</option>
            {Object.entries(EVENT_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value as Severity | '')} aria-label="Niveau">
            <option value="">Tous niveaux</option>
            <option value="normal">Normal</option>
            <option value="warning">Attention</option>
            <option value="critical">Critique</option>
          </select>
          <select value={periodMin} onChange={(e) => setPeriodMin(Number(e.target.value))} aria-label="Période">
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
            <option value={60}>1 heure</option>
            <option value={1440}>24 heures</option>
          </select>
          <input type="search" placeholder="Filtrer par élément…" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Filtrer les événements" />
        </div>
      </div>
      {/* Une zone défilante doit pouvoir être parcourue au clavier : sans
          `tabIndex`, son contenu est inatteignable sans souris ni geste tactile. */}
      <div
        className="scroll-y"
        style={{ marginTop: 'var(--sp-2)', maxHeight: 260 }}
        tabIndex={0}
        role="region"
        aria-label="Liste des événements récents"
      >
        {shown.length === 0 && <div className="empty-state">Aucun événement sur la période choisie.</div>}
        {shown.map((e) => (
          <div key={e.id} className="event-row">
            <span className="mono muted">{fmtTime(e.time)}</span>
            <span className="row small"><StatusDot sev={e.level} /> {EVENT_CATEGORY_LABELS[e.category]}</span>
            <span><b>{e.targetLabel}</b> — {e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
