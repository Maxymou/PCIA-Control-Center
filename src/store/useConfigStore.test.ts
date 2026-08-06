/** Configuration utilisateur : disposition, services manuels, corrections.
 *
 *  Ces fonctions existaient avant la refonte ; ces tests les figent, pour que
 *  la réorganisation de l'interface ne puisse pas les altérer en silence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/dataService', async () => {
  const { emptySnapshot } = await import('../services/types');
  return {
    providerInfo: () => ({ kind: 'mock', mode: 'mock', version: null, fallbackReason: null }),
    dataService: {
      getSnapshot: () => emptySnapshot(),
      subscribe: () => () => {},
      start: () => {},
      pushFanConfigs: vi.fn(),
      lastError: () => null,
    },
  };
});

import { useConfigStore } from './useConfigStore';
import type { Connection } from '../types';

const store = () => useConfigStore.getState();

const DETECTED_CONNECTION: Connection = {
  id: 'cx-1',
  sourceId: 'svc-a',
  targetId: 'svc-b',
  type: 'http',
  port: 8080,
  status: 'active',
  origin: 'detected',
  confidence: 0.9,
};

beforeEach(() => {
  useConfigStore.setState({
    layout: { positions: {} },
    savedLayout: null,
    hiddenServices: [],
    hiddenConnections: [],
    manualServices: [],
    manualConnections: [],
    serviceOverrides: {},
    connectionOverrides: {},
    undoStack: [],
    redoStack: [],
  });
});

describe('disposition du graphe', () => {
  it('mémorise les positions des blocs', () => {
    store().setPositions({ 'svc-a': { x: 120, y: 40 } }, true);
    expect(store().layout.positions['svc-a']).toEqual({ x: 120, y: 40 });
  });

  it('fusionne les positions successives sans perdre les précédentes', () => {
    store().setPositions({ 'svc-a': { x: 10, y: 10 } }, true);
    store().setPositions({ 'svc-b': { x: 20, y: 20 } }, true);
    expect(Object.keys(store().layout.positions).sort()).toEqual(['svc-a', 'svc-b']);
  });

  it('restaure une disposition explicitement mémorisée', () => {
    store().setPositions({ 'svc-a': { x: 10, y: 10 } }, true);
    store().saveLayoutSnapshot();
    store().setPositions({ 'svc-a': { x: 999, y: 999 } }, true);
    store().restoreLayout();
    expect(store().layout.positions['svc-a']).toEqual({ x: 10, y: 10 });
  });

  it('annule et rétablit un déplacement', () => {
    store().setPositions({ 'svc-a': { x: 10, y: 10 } }, true);
    store().setPositions({ 'svc-a': { x: 50, y: 50 } }, true);
    store().undo();
    expect(store().layout.positions['svc-a']).toEqual({ x: 10, y: 10 });
    store().redo();
    expect(store().layout.positions['svc-a']).toEqual({ x: 50, y: 50 });
  });
});

describe('services manuels', () => {
  it('ajoute un service et lui attribue une origine manuelle', () => {
    store().addManualService({ name: 'grafana', type: 'other', status: 'running' });
    const added = store().manualServices[0];
    expect(added.name).toBe('grafana');
    expect(added.origin).toBe('manual');
    expect(added.id).toBeTruthy();
  });

  it('retire un service manuel ainsi que ses connexions', () => {
    store().addManualService({ name: 'grafana', type: 'other', status: 'running' });
    const id = store().manualServices[0].id;
    store().addManualConnection({
      sourceId: id, targetId: 'svc-b', type: 'http', status: 'active',
    });
    expect(store().manualConnections).toHaveLength(1);

    store().removeManualService(id);
    expect(store().manualServices).toHaveLength(0);
    // Une connexion vers un service disparu n'aurait plus de sens.
    expect(store().manualConnections).toHaveLength(0);
  });
});

describe('masquage', () => {
  it('masque puis réaffiche un service détecté', () => {
    // Un service détecté ne se supprime pas : il se masque. La restauration
    // doit rester possible, sans quoi l'information serait perdue.
    store().hideService('svc-a');
    expect(store().hiddenServices).toContain('svc-a');
    store().unhideService('svc-a');
    expect(store().hiddenServices).not.toContain('svc-a');
  });

  it('ne masque pas deux fois le même élément', () => {
    store().hideService('svc-a');
    store().hideService('svc-a');
    expect(store().hiddenServices.filter((id) => id === 'svc-a')).toHaveLength(1);
  });

  it('masque et réaffiche une connexion', () => {
    store().hideConnection('cx-1');
    expect(store().hiddenConnections).toContain('cx-1');
    store().unhideConnection('cx-1');
    expect(store().hiddenConnections).not.toContain('cx-1');
  });
});

describe('correction manuelle d’une connexion', () => {
  it('conserve la détection d’origine', () => {
    store().correctConnection('cx-1', { sourceId: 'svc-b', targetId: 'svc-a' }, DETECTED_CONNECTION);
    const override = store().connectionOverrides['cx-1'];
    expect(override.origin).toBe('corrected');
    expect(override.sourceId).toBe('svc-b');
    // Sans la détection d'origine, il serait impossible de revenir en arrière
    // ni de comparer lors d'un conflit de détection.
    expect(override.detectedOriginal).toMatchObject({
      sourceId: 'svc-a', targetId: 'svc-b', type: 'http', port: 8080,
    });
  });

  it('ne réécrit pas la détection d’origine lors d’une seconde correction', () => {
    store().correctConnection('cx-1', { sourceId: 'svc-b' }, DETECTED_CONNECTION);
    store().correctConnection(
      'cx-1',
      { type: 'websocket' },
      { ...DETECTED_CONNECTION, sourceId: 'svc-b' },
    );
    expect(store().connectionOverrides['cx-1'].detectedOriginal?.sourceId).toBe('svc-a');
  });

  it('restaure les informations détectées', () => {
    store().correctConnection('cx-1', { sourceId: 'svc-b' }, DETECTED_CONNECTION);
    store().restoreDetected('cx-1');
    expect(store().connectionOverrides['cx-1']).toBeUndefined();
  });

  it('ajoute une note sans altérer les autres corrections', () => {
    store().correctConnection('cx-1', { sourceId: 'svc-b' }, DETECTED_CONNECTION);
    store().correctConnection('cx-1', { note: 'Sens vérifié' }, DETECTED_CONNECTION);
    expect(store().connectionOverrides['cx-1']).toMatchObject({
      sourceId: 'svc-b', note: 'Sens vérifié',
    });
  });
});

describe('correction d’un service détecté', () => {
  it('enregistre un nom d’affichage sans toucher au nom technique', () => {
    store().overrideService('svc-a', { displayName: 'Serveur de modèles' });
    expect(store().serviceOverrides['svc-a']).toEqual({ displayName: 'Serveur de modèles' });
  });

  it('cumule les corrections successives', () => {
    store().overrideService('svc-a', { displayName: 'Serveur' });
    store().overrideService('svc-a', { note: 'Redémarré le 12/01' });
    expect(store().serviceOverrides['svc-a']).toEqual({
      displayName: 'Serveur', note: 'Redémarré le 12/01',
    });
  });
});
