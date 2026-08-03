import { useCallback, useEffect, type ComponentType } from 'react';
import { Header } from './components/Header';
import { AlertsPanel } from './components/AlertsPanel';
import { ConflictBanner } from './components/ConflictBanner';
import { AppShell } from './ui/AppShell';
import { UpdateBanner } from './ui/UpdateBanner';
import { useViewportSync } from './ui/useViewport';
import type { SectionId } from './ui/sections';
import { OverviewSection } from './sections/OverviewSection';
import { HardwareSection } from './sections/HardwareSection';
import { ServicesSection } from './sections/ServicesSection';
import { FansSection } from './sections/FansSection';
import { AlertsSection } from './sections/AlertsSection';
import { SettingsSection } from './sections/SettingsSection';
import { useUiStore } from './store/useUiStore';
import { useConfigStore } from './store/useConfigStore';
import { useActiveAlerts } from './store/selectors';
import type { Alert, FanId, HardwareId } from './types';

/** Une section, un composant. L'ajout d'une section se fait ici et dans
 *  `src/ui/sections.ts`, nulle part ailleurs. */
const SECTION_VIEWS: Record<SectionId, ComponentType> = {
  overview: OverviewSection,
  hardware: HardwareSection,
  services: ServicesSection,
  fans: FansSection,
  alerts: AlertsSection,
  settings: SettingsSection,
};

export default function App() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const alertsOpen = useUiStore((s) => s.alertsOpen);
  const setAlertsOpen = useUiStore((s) => s.setAlertsOpen);
  const undo = useConfigStore((s) => s.undo);
  const redo = useConfigStore((s) => s.redo);
  const activeAlerts = useActiveAlerts();

  // Seul point de l'application où la hauteur du viewport est calculée.
  useViewportSync();

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

  /** Ouvre l'élément visé par une alerte dans la section qui le détaille. */
  const openAlertTarget = useCallback((a: Alert) => {
    const ui = useUiStore.getState();
    setAlertsOpen(false);
    if (a.targetKind === 'service') { ui.setTab('services'); ui.selectService(a.targetId); }
    else if (a.targetKind === 'connection') { ui.setTab('services'); ui.selectConnection(a.targetId); }
    else if (a.targetKind === 'fan') { ui.setTab('fans'); ui.selectFan(a.targetId as FanId); }
    else { ui.setTab('hardware'); ui.selectHardware(a.targetId as HardwareId); }
  }, [setAlertsOpen]);

  const SectionView = SECTION_VIEWS[tab];

  return (
    <>
      <AppShell
        header={<Header onOpenAlerts={() => setAlertsOpen(true)} />}
        current={tab}
        onSelect={setTab}
        alertCount={activeAlerts.length}
      >
        <SectionView />
      </AppShell>

      {alertsOpen && (
        <AlertsPanel onClose={() => setAlertsOpen(false)} onOpenTarget={openAlertTarget} />
      )}
      <ConflictBanner />
      <UpdateBanner />
    </>
  );
}
