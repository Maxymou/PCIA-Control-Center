/** Alertes et événements.
 *
 *  Reprend, en page pleine, le contenu du tiroir d'alertes — qui reste
 *  disponible depuis l'en-tête pour une consultation sans quitter la section
 *  courante — et y adjoint le journal des événements.
 */

import { AlertsList } from '../components/AlertsPanel';
import { EventsList } from '../features/hardware/EventsList';
import { useUiStore } from '../store/useUiStore';
import type { Alert, FanId, HardwareId } from '../types';

export function AlertsSection() {
  const setTab = useUiStore((s) => s.setTab);

  /** Ouvre l'élément concerné par une alerte dans sa section. */
  const openTarget = (alert: Alert) => {
    const ui = useUiStore.getState();
    if (alert.targetKind === 'service') {
      setTab('services');
      ui.selectService(alert.targetId);
    } else if (alert.targetKind === 'connection') {
      setTab('services');
      ui.selectConnection(alert.targetId);
    } else if (alert.targetKind === 'fan') {
      setTab('fans');
      ui.selectFan(alert.targetId as FanId);
    } else {
      setTab('hardware');
      ui.selectHardware(alert.targetId as HardwareId);
    }
  };

  return (
    <div className="section">
      <div className="section__inner">
        <section className="card card-pad" aria-labelledby="titre-alertes">
          <h2 className="card-title" id="titre-alertes">Alertes</h2>
          <AlertsList onOpenTarget={openTarget} />
        </section>
        <EventsList />
      </div>
    </div>
  );
}
