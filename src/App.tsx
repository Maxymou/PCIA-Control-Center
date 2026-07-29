import { useEffect } from 'react';
import { Header } from './components/Header';
import { AlertsPanel } from './components/AlertsPanel';
import { DevPanel } from './components/DevPanel';
import { ConflictBanner } from './components/ConflictBanner';
import { ProgramsTab } from './features/programs/ProgramsTab';
import { HardwareTab } from './features/hardware/HardwareTab';
import { useUiStore } from './store/useUiStore';
import { useConfigStore } from './store/useConfigStore';
import type { Alert, FanId, HardwareId } from './types';

export default function App() {
  const { tab, setTab, alertsOpen, setAlertsOpen } = useUiStore();
  const undo = useConfigStore((s) => s.undo);
  const redo = useConfigStore((s) => s.redo);

  // Raccourcis globaux : Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); redo();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [undo, redo]);

  const openAlertTarget = (a: Alert) => {
    const ui = useUiStore.getState();
    setAlertsOpen(false);
    if (a.targetKind === 'service') { ui.setTab('programs'); ui.selectService(a.targetId); }
    else if (a.targetKind === 'connection') { ui.setTab('programs'); ui.selectConnection(a.targetId); }
    else if (a.targetKind === 'fan') { ui.setTab('hardware'); ui.selectFan(a.targetId as FanId); }
    else { ui.setTab('hardware'); ui.selectHardware(a.targetId as HardwareId); }
  };

  return (
    <div className="app">
      <Header onOpenAlerts={() => setAlertsOpen(true)} />
      <nav className="tabs" aria-label="Navigation principale">
        <button className={tab === 'programs' ? 'active' : ''} onClick={() => setTab('programs')}>
          Programmes
        </button>
        <button className={tab === 'hardware' ? 'active' : ''} onClick={() => setTab('hardware')}>
          Hardware &amp; Ventilation
        </button>
      </nav>
      <main className="tab-content">
        {tab === 'programs' ? <ProgramsTab /> : <HardwareTab />}
      </main>
      {alertsOpen && <AlertsPanel onClose={() => setAlertsOpen(false)} onOpenTarget={openAlertTarget} />}
      <ConflictBanner />
      <DevPanel />
    </div>
  );
}
