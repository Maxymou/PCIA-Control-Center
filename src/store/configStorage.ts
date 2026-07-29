/** Stockage de la configuration d'interface.
 *
 *  En présence d'un back-end, les préférences (disposition du graphe, filtres,
 *  masquages, notes…) sont persistées **côté serveur** dans SQLite : elles
 *  suivent l'utilisateur d'un navigateur à l'autre et survivent au vidage du
 *  cache. `localStorage` sert alors de miroir local, utilisé en repli si le
 *  serveur ne répond pas.
 *
 *  Sans back-end (mode simulation), le comportement d'origine est conservé :
 *  `localStorage` seul, clé `pcia-config`.
 */

import type { StateStorage } from 'zustand/middleware';
import { dataService, providerInfo } from '../services/dataService';

/** Délai de regroupement des écritures serveur (le graphe écrit en rafale). */
const SAVE_DEBOUNCE_MS = 600;

export type SaveOutcome = 'saved' | 'saving' | 'error';

type SaveListener = (state: SaveOutcome) => void;

let saveListener: SaveListener | null = null;
let lastNotified: SaveOutcome | null = null;

/** Permet au store d'afficher l'état d'enregistrement réel. */
export function onSaveStateChange(listener: SaveListener | null): void {
  saveListener = listener;
  lastNotified = null;
}

/** Le listener écrit dans le store, ce qui redéclenche une persistance :
 *  ne notifier que sur changement effectif évite la boucle infinie. */
function notify(state: SaveOutcome): void {
  if (state === lastNotified) return;
  lastNotified = state;
  saveListener?.(state);
}

let pendingValue: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Dernière charge utile réellement écrite, pour ignorer les écritures inutiles. */
let lastWritten: string | null = null;

async function flush(name: string): Promise<void> {
  if (pendingValue === null) return;
  const value = pendingValue;
  pendingValue = null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    await dataService.saveUiState?.(parsed);
    notify('saved');
  } catch {
    // L'échec côté serveur n'est pas silencieux : l'interface l'affiche, et la
    // copie locale reste disponible pour ne rien perdre.
    try {
      localStorage.setItem(name, value);
    } catch {
      /* quota dépassé : rien de plus à tenter */
    }
    notify('error');
  }
}

export function createHybridStorage(): StateStorage {
  return {
    async getItem(name: string): Promise<string | null> {
      if (providerInfo().kind === 'api') {
        const remote = await dataService.loadUiState?.();
        if (remote && Object.keys(remote).length > 0) {
          // Miroir local, utile si le serveur devient injoignable.
          try {
            localStorage.setItem(name, JSON.stringify(remote));
          } catch {
            /* ignoré */
          }
          return JSON.stringify(remote);
        }
      }
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },

    setItem(name: string, value: string): void {
      // Contenu identique : rien à persister (le store écrit à chaque `set`).
      if (value === lastWritten) return;
      lastWritten = value;
      // Écriture locale immédiate : aucun état perdu en cas de rechargement.
      try {
        localStorage.setItem(name, value);
      } catch {
        /* quota dépassé */
      }
      if (providerInfo().kind !== 'api') {
        notify('saved');
        return;
      }
      notify('saving');
      pendingValue = value;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void flush(name), SAVE_DEBOUNCE_MS);
    },

    removeItem(name: string): void {
      try {
        localStorage.removeItem(name);
      } catch {
        /* ignoré */
      }
      if (providerInfo().kind === 'api') {
        void dataService.saveUiState?.({});
      }
    },
  };
}
