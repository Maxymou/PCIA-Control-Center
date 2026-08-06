/** État de liaison : la décision unique qui autorise ou refuse les commandes.
 *
 *  Ces tests protègent les garanties de sûreté hors ligne — elles ne doivent
 *  pas pouvoir être affaiblies par inadvertance.
 */

import { renderHook, act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOnline } from '../test/setup';

// Le fournisseur de données est simulé : ces tests portent sur la logique de
// décision, pas sur le transport.
const providerState = { kind: 'api' as 'api' | 'mock', mode: 'hardware' as string };
vi.mock('../services/dataService', async () => {
  const { emptySnapshot } = await import('../services/types');
  return {
    providerInfo: () => ({ ...providerState, version: '1.0.0', fallbackReason: null }),
    dataService: {
      lastError: () => null,
      // `useLiveStore` lit un instantané à la création du store.
      getSnapshot: () => emptySnapshot(),
      subscribe: () => () => {},
      start: () => {},
    },
  };
});

import { STALE_AFTER_MS, formatAge, useConnectionState } from './useConnectionState';
import { ConnectionBanner } from './ConnectionBanner';
import { useLiveStore } from '../store/useLiveStore';

function setSnapshot(patch: { backendConnected?: boolean; time?: number; mode?: 'hardware' | 'demo' }) {
  useLiveStore.setState((s) => ({
    snap: {
      ...s.snap,
      backendConnected: patch.backendConnected ?? true,
      time: patch.time ?? Date.now(),
      system: patch.mode
        ? ({ ...(s.snap.system ?? {}), mode: patch.mode } as never)
        : s.snap.system,
    },
  }));
}

beforeEach(() => {
  providerState.kind = 'api';
  providerState.mode = 'hardware';
  setSnapshot({ backendConnected: true, time: Date.now(), mode: 'hardware' });
  setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liaison saine', () => {
  it('autorise les commandes et ne donne aucun motif de blocage', () => {
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('live');
    expect(result.current.commandsEnabled).toBe(true);
    expect(result.current.blockedReason).toBeNull();
  });
});

describe('back-end injoignable', () => {
  it('refuse les commandes', () => {
    setSnapshot({ backendConnected: false });
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('offline');
    expect(result.current.commandsEnabled).toBe(false);
    expect(result.current.blockedReason).toMatch(/injoignable/i);
  });

  it('refuse les commandes quand l’appareil lui-même est hors ligne', () => {
    setOnline(false);
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('offline');
    expect(result.current.commandsEnabled).toBe(false);
    expect(result.current.blockedReason).toMatch(/hors ligne/i);
  });
});

describe('données périmées', () => {
  it('refuse les commandes au-delà du seuil, même si la liaison se croit ouverte', () => {
    // Cas le plus dangereux : le WebSocket n'a pas signalé sa perte, mais plus
    // aucune mesure n'arrive. L'écran semble normal et ne l'est pas.
    setSnapshot({ backendConnected: true, time: Date.now() - STALE_AFTER_MS - 1000 });
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('stale');
    expect(result.current.commandsEnabled).toBe(false);
    expect(result.current.blockedReason).toMatch(/plus actualisées/i);
  });

  it('bascule seule à l’expiration du délai, sans nouvel événement', () => {
    vi.useFakeTimers();
    setSnapshot({ backendConnected: true, time: Date.now() });
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('live');

    act(() => { vi.advanceTimersByTime(STALE_AFTER_MS + 2000); });
    expect(result.current.status).toBe('stale');
    expect(result.current.commandsEnabled).toBe(false);
  });
});

describe('simulation navigateur', () => {
  it('marque les données comme simulées sans bloquer les commandes locales', () => {
    providerState.kind = 'mock';
    providerState.mode = 'mock';
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.status).toBe('simulation');
    expect(result.current.simulated).toBe(true);
    // Aucune commande n'atteint de matériel : il n'y a rien à interdire.
    expect(result.current.commandsEnabled).toBe(true);
  });
});

describe('mode démonstration du back-end', () => {
  it('signale que les valeurs sont simulées', () => {
    setSnapshot({ mode: 'demo' });
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.simulated).toBe(true);
  });
});

describe('bandeau d’état', () => {
  it('reste absent quand tout va bien', () => {
    const { container } = render(<ConnectionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('annonce la coupure, l’heure des données et l’absence de file d’attente', () => {
    const at = new Date('2026-01-15T14:32:05').getTime();
    setSnapshot({ backendConnected: false, time: at });
    render(<ConnectionBanner />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/liaison perdue/i);
    // L'heure exacte des dernières mesures doit être lisible.
    expect(banner).toHaveTextContent('14:32:05');
    expect(banner).toHaveTextContent(/commandes matérielles sont désactivées/i);
    // La garantie la plus importante : rien n'est rejoué automatiquement.
    expect(banner).toHaveTextContent(/aucune commande n’est mise en attente/i);
    expect(banner).toHaveTextContent(/rien ne sera envoyé automatiquement/i);
  });

  it('distingue des données vieillissantes d’une liaison perdue', () => {
    setSnapshot({ backendConnected: true, time: Date.now() - STALE_AFTER_MS - 1000 });
    render(<ConnectionBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent(/données non actualisées/i);
  });

  it('annonce la simulation locale sans la présenter comme une panne', () => {
    providerState.kind = 'mock';
    providerState.mode = 'mock';
    render(<ConnectionBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/simulation locale/i);
    expect(banner).toHaveTextContent(/aucune commande n’atteint de matériel réel/i);
  });
});

describe('formatAge', () => {
  it('exprime l’ancienneté en secondes, minutes puis heures', () => {
    expect(formatAge(3000)).toBe('il y a 3 s');
    expect(formatAge(120_000)).toBe('il y a 2 min');
    expect(formatAge(7_200_000)).toBe('il y a 2 h');
  });
});
