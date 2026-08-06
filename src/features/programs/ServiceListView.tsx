/** Vue liste des services et connexions.
 *
 *  Présentation alternative au graphe, et non version dégradée : sur un écran
 *  de 390 px, un graphe de nœuds de 210 px de large n'est pas lisible — le
 *  compresser reviendrait à le rendre inutilisable. La liste donne accès aux
 *  mêmes services, aux mêmes connexions et aux mêmes actions, avec un mode de
 *  consultation adapté au doigt.
 *
 *  Elle reste disponible sur poste de travail : certains utilisateurs préfèrent
 *  parcourir une liste triée plutôt qu'un graphe.
 */

import { useMemo } from 'react';
import { useUiStore } from '../../store/useUiStore';
import { useConfigStore } from '../../store/useConfigStore';
import { useLiveStore } from '../../store/useLiveStore';
import { serviceLabel, useVisibleConnections, useVisibleServices } from '../../store/selectors';
import {
  CONN_TYPE_LABELS, SERVICE_STATUS_LABELS, SERVICE_STATUS_SEVERITY,
  SERVICE_TYPE_ICONS, SERVICE_TYPE_LABELS,
} from '../../utils/labels';
import { StatusDot } from '../../components/Common';

export function ServiceListView() {
  const services = useVisibleServices();
  const serviceIds = useMemo(() => new Set(services.map((s) => s.id)), [services]);
  const connections = useVisibleConnections(serviceIds);
  const alerts = useLiveStore((s) => s.snap.alerts);
  const groups = useConfigStore((s) => s.groups);
  const selectedServiceId = useUiStore((s) => s.selectedServiceId);
  const selectService = useUiStore((s) => s.selectService);
  const selectConnection = useUiStore((s) => s.selectConnection);

  /** Nombre de liens par service, pour situer chaque bloc dans l'ensemble. */
  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of connections) {
      map.set(c.sourceId, (map.get(c.sourceId) ?? 0) + 1);
      map.set(c.targetId, (map.get(c.targetId) ?? 0) + 1);
    }
    return map;
  }, [connections]);

  const groupOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) for (const id of g.serviceIds) map.set(id, g.name);
    return map;
  }, [groups]);

  // Les services en défaut remontent en tête : sur un petit écran, on ne doit
  // pas avoir à faire défiler pour voir ce qui ne va pas.
  const sorted = useMemo(() => {
    const rank = { critical: 0, warning: 1, unknown: 2, normal: 3 } as const;
    return [...services].sort((a, b) => {
      const ra = rank[SERVICE_STATUS_SEVERITY[a.status]];
      const rb = rank[SERVICE_STATUS_SEVERITY[b.status]];
      if (ra !== rb) return ra - rb;
      return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, 'fr');
    });
  }, [services]);

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        Aucun service détecté ou visible. Ajustez les filtres ou ajoutez un service
        manuellement depuis la barre d’outils.
      </div>
    );
  }

  return (
    <div className="service-list-wrap scroll-y">
      <p className="sr-only" role="status">
        {sorted.length} service(s) affiché(s), {connections.length} connexion(s).
      </p>
      <ul className="service-list">
        {sorted.map((service) => {
          const sev = SERVICE_STATUS_SEVERITY[service.status];
          const hasAlert = alerts.some((a) => a.active && a.targetId === service.id);
          const links = connections.filter(
            (c) => c.sourceId === service.id || c.targetId === service.id,
          );
          const group = groupOf.get(service.id);

          return (
            <li key={service.id}>
              <button
                type="button"
                className={`service-list__item${selectedServiceId === service.id ? ' selected' : ''}`}
                aria-pressed={selectedServiceId === service.id}
                onClick={() => selectService(service.id)}
              >
                <StatusDot sev={sev} pulse={sev === 'critical'} />
                <span className="service-list__name">
                  <span aria-hidden="true">{SERVICE_TYPE_ICONS[service.type]} </span>
                  {service.displayName ?? service.name}
                </span>
                <span className={`badge ${sev === 'normal' ? 'normal' : sev === 'unknown' ? '' : sev}`}>
                  {SERVICE_STATUS_LABELS[service.status]}
                </span>

                <span className="service-list__meta">
                  <span>{SERVICE_TYPE_LABELS[service.type]}</span>
                  {service.port && <span className="mono">:{service.port}</span>}
                  {service.container && <span className="mono">{service.container}</span>}
                  {group && <span className="badge outline">{group}</span>}
                  {service.origin === 'manual' && <span className="badge accent">Manuel</span>}
                  {hasAlert && <span className="badge warning">Alerte</span>}
                  <span>
                    {links.length} connexion{links.length > 1 ? 's' : ''}
                    {degree.get(service.id) === undefined && ' — isolé'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Les connexions ne sont pas dérivables de la liste des services : on les
          présente séparément, avec le même accès au détail que dans le graphe. */}
      <h3 className="card-title" style={{ marginTop: 'var(--sp-4)' }}>
        Connexions ({connections.length})
      </h3>
      <ul className="service-list">
        {connections.map((c) => {
          const sev = c.status === 'active' ? 'normal'
            : c.status === 'degraded' ? 'warning'
              : c.status === 'lost' ? 'critical' : 'unknown';
          return (
            <li key={c.id}>
              <button
                type="button"
                className="service-list__item"
                onClick={() => selectConnection(c.id)}
              >
                <StatusDot sev={sev} />
                <span className="service-list__name">
                  {serviceLabel(services, c.sourceId)}
                  {' → '}
                  {serviceLabel(services, c.targetId)}
                </span>
                <span className="badge outline">{CONN_TYPE_LABELS[c.type]}</span>
                <span className="service-list__meta">
                  {c.port && <span className="mono">port {c.port}</span>}
                  {c.origin === 'manual' && <span className="badge accent">Manuelle</span>}
                  {c.origin === 'corrected' && <span className="badge accent">Corrigée</span>}
                  {c.confidence !== undefined && (
                    <span>confiance {Math.round(c.confidence * 100)} %</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
