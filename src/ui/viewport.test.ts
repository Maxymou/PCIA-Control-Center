/** Hauteur de l'application — les cas qui cassent l'affichage sur iOS.
 *
 *  Ces tests valent surtout par ce qu'ils interdisent : que l'ouverture du
 *  clavier rétracte le shell, et qu'une rotation laisse une hauteur périmée.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetViewportForTests, currentViewport, startViewportSync, stopViewportSync, syncViewport,
} from './viewport';
import { closeKeyboard, openKeyboard, rotate, setViewportSize } from '../test/setup';

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');
const vvh = () => document.documentElement.style.getPropertyValue('--vvh');

beforeEach(() => {
  __resetViewportForTests();
  setViewportSize(390, 844, { coarse: true });
});

afterEach(() => {
  stopViewportSync();
  __resetViewportForTests();
});

describe('initialisation', () => {
  it('écrit --app-height et --vvh dès la première synchronisation', () => {
    startViewportSync();
    expect(appHeight()).toBe('844px');
    expect(vvh()).toBe('844px');
  });

  it('expose les mesures courantes', () => {
    startViewportSync();
    expect(currentViewport()).toMatchObject({ appHeight: 844, visualHeight: 844, keyboardOpen: false });
  });

  it('ne pose qu’un seul jeu d’écouteurs même appelée plusieurs fois', () => {
    const stopA = startViewportSync();
    const stopB = startViewportSync();
    expect(stopA).toBe(stopB);
    stopA();
    // Après arrêt, un nouveau démarrage reste possible.
    startViewportSync();
    expect(appHeight()).toBe('844px');
  });
});

describe('clavier virtuel', () => {
  it('ne réduit pas --app-height quand le clavier s’ouvre', () => {
    startViewportSync();
    expect(appHeight()).toBe('844px');

    // Clavier de 320 px : c'est la fenêtre visible qui rétrécit, pas la
    // fenêtre de disposition. Sans repère haut, tout le shell sauterait.
    openKeyboard(320);
    expect(appHeight()).toBe('844px');
  });

  it('reflète la hauteur réellement visible dans --vvh', () => {
    startViewportSync();
    openKeyboard(320);
    expect(vvh()).toBe('524px');
  });

  it('signale l’ouverture du clavier par une classe sur la racine', () => {
    startViewportSync();
    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(false);
    openKeyboard(320);
    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(true);
  });

  it('rétablit --vvh à la fermeture du clavier', () => {
    startViewportSync();
    openKeyboard(320);
    closeKeyboard();
    expect(vvh()).toBe('844px');
    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(false);
  });

  it('ne considère pas une barre d’outils rétractable comme un clavier', () => {
    startViewportSync();
    // Réduction de 60 px : barre d'URL, pas clavier. Aucun basculement d'état.
    openKeyboard(60);
    expect(document.documentElement.classList.contains('is-keyboard-open')).toBe(false);
    expect(appHeight()).toBe('844px');
  });
});

describe('rotation', () => {
  it('réinitialise le repère haut sur un vrai changement d’orientation', () => {
    startViewportSync();
    expect(appHeight()).toBe('844px');

    // Passage en paysage : la hauteur doit *diminuer*, ce que le repère haut
    // empêcherait s'il n'était pas réinitialisé.
    rotate();
    syncViewport();
    expect(appHeight()).toBe('390px');
  });

  it('revient à la hauteur d’origine au retour en portrait', () => {
    startViewportSync();
    rotate();
    syncViewport();
    rotate();
    syncViewport();
    expect(appHeight()).toBe('844px');
  });

  it('ne réinitialise pas le repère sur un simple redimensionnement', () => {
    startViewportSync();
    // Même orientation, hauteur momentanément plus faible (barre d'outils) :
    // la hauteur stable ne doit pas suivre vers le bas.
    setViewportSize(390, 800, { coarse: true });
    syncViewport();
    expect(appHeight()).toBe('844px');
  });
});

describe('agrandissement de la fenêtre', () => {
  it('suit une augmentation de hauteur sans attendre une rotation', () => {
    startViewportSync();
    setViewportSize(390, 900, { coarse: true });
    syncViewport();
    expect(appHeight()).toBe('900px');
  });
});
