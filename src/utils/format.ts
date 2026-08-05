import type { RpmSource } from '../types';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- Vitesses de rotation ----------

/** Affichage d'une vitesse, provenance comprise.
 *
 *  Trois rendus volontairement distincts : « 1240 RPM » (mesure réelle),
 *  « 1240 RPM (simulé) » (mode démonstration), « indisponible » (aucune mesure).
 *  Un ventilateur réellement arrêté affiche « 0 RPM » — et cet affichage ne doit
 *  jamais pouvoir être produit par une lecture manquante. */
export function fmtRpm(rpm: number | null | undefined, source: RpmSource = 'measured'): string {
  if (rpm === null || rpm === undefined || source === 'unavailable') return 'indisponible';
  return source === 'simulated' ? `${rpm} RPM (simulé)` : `${rpm} RPM`;
}

/** Version courte pour les zones denses (listes, schéma) : « — » si absente. */
export function fmtRpmShort(rpm: number | null | undefined, source: RpmSource = 'measured'): string {
  if (rpm === null || rpm === undefined || source === 'unavailable') return '—';
  return source === 'simulated' ? `~${rpm} RPM` : `${rpm} RPM`;
}

/** Formulation destinée aux lecteurs d'écran. */
export function rpmAriaLabel(rpm: number | null | undefined, source: RpmSource = 'measured'): string {
  if (rpm === null || rpm === undefined || source === 'unavailable') return 'vitesse indisponible';
  const suffix = source === 'simulated' ? ' (valeur simulée)' : '';
  return `${rpm} tours par minute${suffix}`;
}
