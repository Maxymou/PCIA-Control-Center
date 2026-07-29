/** Fusion des données simulées (détectées) et de la configuration utilisateur :
 *  overrides, corrections, éléments manuels, masquages, filtres. */

import type { Alert, Connection, Service, Severity } from '../types';
import { SERVICE_STATUS_SEVERITY } from '../utils/labels';
import { useConfigStore } from './useConfigStore';
import { useLiveStore } from './useLiveStore';

/** Tous les services (détectés + manuels) avec overrides, hors masquage. */
export function useAllServices(): Service[] {
  const detected = useLiveStore((s) => s.snap.services);
  const manual = useConfigStore((s) => s.manualServices);
  const overrides = useConfigStore((s) => s.serviceOverrides);
  return [
    ...detected.map((s) => ({ ...s, ...overrides[s.id] })),
    ...manual,
  ];
}

export function useVisibleServices(): Service[] {
  const all = useAllServices();
  const hidden = useConfigStore((s) => s.hiddenServices);
  const filters = useConfigStore((s) => s.filters);
  return all.filter((s) => {
    if (hidden.includes(s.id)) return false;
    if (filters.statuses.length && !filters.statuses.includes(s.status)) return false;
    if (filters.types.length && !filters.types.includes(s.type)) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!(s.displayName ?? s.name).toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** Toutes les connexions (détectées corrigées + manuelles), hors masquage. */
export function useAllConnections(): Connection[] {
  const detected = useLiveStore((s) => s.snap.connections);
  const manual = useConfigStore((s) => s.manualConnections);
  const overrides = useConfigStore((s) => s.connectionOverrides);
  // Les corrections manuelles restent prioritaires sur les données détectées.
  return [...detected.map((c) => ({ ...c, ...overrides[c.id] })), ...manual];
}

export function useVisibleConnections(visibleServiceIds: Set<string>): Connection[] {
  const all = useAllConnections();
  const hidden = useConfigStore((s) => s.hiddenConnections);
  return all.filter(
    (c) => !hidden.includes(c.id) && visibleServiceIds.has(c.sourceId) && visibleServiceIds.has(c.targetId),
  );
}

export function useActiveAlerts(): Alert[] {
  const alerts = useLiveStore((s) => s.snap.alerts);
  const now = Date.now();
  return alerts.filter((a) => a.active && (!a.snoozedUntil || a.snoozedUntil < now));
}

/** État général de la machine, dérivé des alertes actives et du matériel. */
export function useGlobalStatus(): Severity {
  const alerts = useActiveAlerts();
  const hardware = useLiveStore((s) => s.snap.hardware);
  const services = useLiveStore((s) => s.snap.services);
  if (alerts.some((a) => a.level === 'critical')) return 'critical';
  if (hardware.some((h) => h.installed && h.metrics.status === 'critical')) return 'critical';
  if (services.some((s) => SERVICE_STATUS_SEVERITY[s.status] === 'critical')) return 'critical';
  if (alerts.length > 0 || hardware.some((h) => h.installed && h.metrics.status === 'warning')) return 'warning';
  return 'normal';
}

export function serviceLabel(services: Service[], id: string): string {
  const s = services.find((x) => x.id === id);
  return s ? s.displayName ?? s.name : id;
}
