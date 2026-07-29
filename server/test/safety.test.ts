/** Sécurités : elles doivent être conservatrices, jamais optimistes. */

import { describe, expect, it } from 'vitest';
import { configSchema, type AppConfig } from '../src/config.js';
import {
  applyLimits, emptyStallState, rpmInconsistent, sensorSafety, temperatureSafety, updateStall,
} from '../src/fan/safety.js';
import { effectiveMinPwm, PASSIVE_COOLING_FANS, PASSIVE_FLOOR_PWM } from '../src/fan/defaults.js';

const config: AppConfig = configSchema.parse({});

describe('sensorSafety', () => {
  it('ne fait rien tant que le capteur répond', () => {
    expect(sensorSafety({ lostSince: null }, config, Date.now()).forcedPwm).toBeNull();
  });

  it('applique la vitesse de secours dès la perte du capteur', () => {
    const now = Date.now();
    const decision = sensorSafety({ lostSince: now - 1000 }, config, now);
    expect(decision.forcedPwm).toBe(config.fanControl.sensorFailurePwm);
    expect(decision.alert).toBe('warning');
  });

  it('passe à la consigne critique quand la perte se prolonge', () => {
    const now = Date.now();
    const decision = sensorSafety({ lostSince: now - config.fanControl.sensorGraceMs - 1 }, config, now);
    expect(decision.forcedPwm).toBe(config.fanControl.criticalPwm);
    expect(decision.alert).toBe('critical');
  });
});

describe('temperatureSafety', () => {
  it('force 100 % au seuil critique', () => {
    const decision = temperatureSafety(config.alerts.criticalTemperatureC, config);
    expect(decision.forcedPwm).toBe(100);
    expect(decision.alert).toBe('critical');
  });

  it('ne force rien en dessous du seuil', () => {
    expect(temperatureSafety(config.alerts.criticalTemperatureC - 1, config).forcedPwm).toBeNull();
  });

  it('reste neutre si la température est inconnue (la sécurité capteur prend le relais)', () => {
    expect(temperatureSafety(null, config).forcedPwm).toBeNull();
  });

  it('produit un message constant : il sert de clé de déduplication d’alerte', () => {
    const a = temperatureSafety(95, config).message;
    const b = temperatureSafety(101, config).message;
    expect(a).toBe(b);
  });
});

describe('updateStall — un RPM nul ne suffit pas à déclencher une alerte', () => {
  const base = { hasTach: true, enabled: true };
  const t0 = 1_000_000;

  it('ignore un RPM nul quand la consigne est faible', () => {
    const result = updateStall(emptyStallState(), { ...base, pwm: 10, rpm: 0 }, config, t0);
    expect(result.stalled).toBe(false);
  });

  it('ignore un ventilateur qui tourne', () => {
    const result = updateStall(emptyStallState(), { ...base, pwm: 80, rpm: 900 }, config, t0);
    expect(result.stalled).toBe(false);
  });

  it('exige plusieurs lectures consécutives ET une durée', () => {
    let state = emptyStallState();
    const input = { ...base, pwm: 60, rpm: 0 };

    // Première lecture : la condition démarre, rien n'est signalé.
    let result = updateStall(state, input, config, t0);
    expect(result.stalled).toBe(false);
    state = result.state;

    // Assez de lectures mais pas assez de temps écoulé.
    result = updateStall(state, input, config, t0 + 100);
    state = result.state;
    result = updateStall(state, input, config, t0 + 200);
    expect(result.stalled).toBe(false);
    state = result.state;

    // Durée dépassée : détection.
    result = updateStall(state, input, config, t0 + config.fanControl.stall.delayMs + 1);
    expect(result.stalled).toBe(true);
    expect(result.justDetected).toBe(true);

    // L'alerte n'est signalée qu'une fois.
    const again = updateStall(result.state, input, config, t0 + config.fanControl.stall.delayMs + 2000);
    expect(again.stalled).toBe(true);
    expect(again.justDetected).toBe(false);
  });

  it('réinitialise l’état dès que le ventilateur repart', () => {
    let state = emptyStallState();
    for (let i = 0; i < 5; i++) {
      state = updateStall(state, { ...base, pwm: 60, rpm: 0 }, config, t0 + i * 5000).state;
    }
    const recovered = updateStall(state, { ...base, pwm: 60, rpm: 700 }, config, t0 + 30_000);
    expect(recovered.stalled).toBe(false);
    expect(recovered.state.since).toBeNull();
  });

  it('reste inactif sur une sortie sans tachymètre', () => {
    let state = emptyStallState();
    for (let i = 0; i < 5; i++) {
      state = updateStall(state, { pwm: 90, rpm: null, hasTach: false, enabled: true }, config, t0 + i * 5000).state;
    }
    expect(updateStall(state, { pwm: 90, rpm: null, hasTach: false, enabled: true }, config, t0 + 60_000).stalled).toBe(false);
  });

  it('respecte la désactivation explicite de la détection', () => {
    const result = updateStall(emptyStallState(), { pwm: 90, rpm: 0, hasTach: true, enabled: false }, config, t0);
    expect(result.stalled).toBe(false);
  });
});

describe('rpmInconsistent', () => {
  it('signale un RPM anormalement bas à consigne élevée', () => {
    expect(rpmInconsistent(80, 120, 300)).toBe(true);
  });

  it('ne signale rien à l’arrêt ou sans tachymètre', () => {
    expect(rpmInconsistent(80, 0, 300)).toBe(false);
    expect(rpmInconsistent(80, null, 300)).toBe(false);
  });
});

describe('applyLimits', () => {
  it('applique le plancher configuré', () => {
    expect(applyLimits({ fanId: 'SYS_FAN1', requestedPwm: 5, minPwm: 15, hardFloor: 0, allowStop: false })).toBe(15);
  });

  it('n’autorise l’arrêt complet que sans plancher matériel et sur demande explicite', () => {
    expect(applyLimits({ fanId: 'SYS_FAN1', requestedPwm: 0, minPwm: 15, hardFloor: 0, allowStop: true })).toBe(0);
    expect(applyLimits({ fanId: 'SYS_FAN1', requestedPwm: 0, minPwm: 15, hardFloor: 0, allowStop: false })).toBe(15);
  });

  it('interdit l’arrêt d’un ventilateur de matériel passif même sur demande', () => {
    expect(applyLimits({
      fanId: 'SYS_FAN3', requestedPwm: 0, minPwm: 0, hardFloor: PASSIVE_FLOOR_PWM, allowStop: true,
    })).toBe(PASSIVE_FLOOR_PWM);
  });

  it('borne la consigne à 0–100', () => {
    expect(applyLimits({ fanId: 'CPU_FAN1', requestedPwm: 250, minPwm: 0, hardFloor: 0, allowStop: false })).toBe(100);
  });
});

describe('effectiveMinPwm', () => {
  it('impose le plancher aux sorties des cartes passives', () => {
    for (const id of PASSIVE_COOLING_FANS) {
      expect(effectiveMinPwm(id, 0)).toBeGreaterThanOrEqual(PASSIVE_FLOOR_PWM);
    }
  });

  it('respecte un minimum plus élevé choisi par l’utilisateur', () => {
    expect(effectiveMinPwm('SYS_FAN3', 60)).toBe(60);
  });

  it('laisse les autres sorties descendre à zéro', () => {
    expect(effectiveMinPwm('SYS_FAN1', 0)).toBe(0);
  });
});
