/** État de la liaison avec le back-end — point de décision unique.
 *
 *  Un seul endroit décide si les commandes sont autorisées, et cette décision
 *  est volontairement pessimiste : dès que la fraîcheur des données n'est plus
 *  garantie, toute commande matérielle est refusée côté interface.
 *
 *  Règles non négociables de cette application :
 *   - aucune mutation n'est jamais mise en file d'attente hors ligne ;
 *   - aucune commande de ventilation n'est rejouée automatiquement plus tard ;
 *   - une donnée périmée est affichée comme périmée, avec son heure ;
 *   - un succès n'est affiché qu'après confirmation du serveur.
 *
 *  Le mode simulation navigateur est un cas à part : il n'y a pas de back-end,
 *  donc pas de risque matériel, mais l'interface doit dire que tout est simulé.
 */

import { useEffect, useState } from 'react';
import { useLiveStore } from '../store/useLiveStore';
import { dataService, providerInfo } from '../services/dataService';

/** Au-delà de ce délai sans nouvelle mesure, les données sont périmées, même si
 *  le WebSocket se croit encore ouvert. Le back-end publie un instantané au
 *  moins toutes les 2 s ; 15 s laissent largement la place à un ralentissement
 *  passager sans masquer une vraie coupure. */
export const STALE_AFTER_MS = 15_000;

export type LinkStatus =
  /** Flux temps réel actif, données fraîches. */
  | 'live'
  /** Back-end joignable mais données vieillissantes (WebSocket coupé, repli REST). */
  | 'stale'
  /** Back-end injoignable. */
  | 'offline'
  /** Aucun back-end : moteur de simulation local du navigateur. */
  | 'simulation';

export interface ConnectionState {
  status: LinkStatus;
  /** Horodatage de la dernière mesure reçue. */
  lastUpdate: number;
  /** Âge de cette mesure, en millisecondes. */
  ageMs: number;
  /** Les commandes atteignant le matériel sont-elles autorisées ? */
  commandsEnabled: boolean;
  /** Motif du refus, à afficher tel quel à l'utilisateur. `null` si autorisé. */
  blockedReason: string | null;
  /** Les valeurs affichées proviennent-elles d'une simulation ? */
  simulated: boolean;
  /** Dernière erreur réseau signalée par la couche de données. */
  lastError: string | null;
  /** Le navigateur se déclare-t-il hors ligne ? */
  browserOffline: boolean;
}

/** Réévalue périodiquement : l'âge des données augmente sans qu'aucun événement
 *  ne se produise — c'est précisément le cas d'une coupure silencieuse. */
const TICK_MS = 1000;

export function useConnectionState(): ConnectionState {
  const backendConnected = useLiveStore((s) => s.snap.backendConnected);
  const time = useLiveStore((s) => s.snap.time);
  const system = useLiveStore((s) => s.snap.system);

  const [now, setNow] = useState(() => Date.now());
  const [browserOffline, setBrowserOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    const online = () => setBrowserOffline(false);
    const offline = () => setBrowserOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  const provider = providerInfo();
  const lastError = dataService.lastError?.() ?? null;
  const ageMs = Math.max(0, now - time);

  if (provider.kind === 'mock') {
    // Simulation locale : aucune commande n'atteint de matériel, donc rien à
    // interdire — mais tout est simulé, et l'interface doit le dire partout.
    return {
      status: 'simulation',
      lastUpdate: time,
      ageMs,
      commandsEnabled: true,
      blockedReason: null,
      simulated: true,
      lastError,
      browserOffline,
    };
  }

  // Le mode démonstration du back-end est simulé côté serveur : les commandes
  // sont acceptées, mais aucune n'atteint le matériel.
  const simulated = (system?.mode ?? provider.mode) !== 'hardware';

  let status: LinkStatus;
  let blockedReason: string | null = null;

  if (browserOffline || !backendConnected) {
    status = 'offline';
    blockedReason = browserOffline
      ? 'l’appareil est hors ligne. Les commandes matérielles sont désactivées tant que la liaison n’est pas rétablie.'
      : 'le back-end est injoignable. Les commandes matérielles sont désactivées tant que la liaison n’est pas rétablie.';
  } else if (ageMs > STALE_AFTER_MS) {
    status = 'stale';
    blockedReason = 'les données affichées ne sont plus actualisées. Les commandes matérielles sont désactivées tant que le flux temps réel n’a pas repris.';
  } else {
    status = 'live';
  }

  return {
    status,
    lastUpdate: time,
    ageMs,
    // Aucune mise en file d'attente : une commande refusée ici n'est pas
    // mémorisée, pas différée, pas rejouée. L'utilisateur devra la réémettre.
    commandsEnabled: status === 'live',
    blockedReason,
    simulated,
    lastError,
    browserOffline,
  };
}

/** Âge lisible, pour l'affichage à côté de l'heure de dernière mise à jour. */
export function formatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `il y a ${hours} h`;
}
