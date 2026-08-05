/** Assistant de calibration : le bouton « Autoriser » ne doit jamais être
 *  proposé pour une sortie `monitoring_only` (supervision tachymétrique
 *  seule), quel que soit son état de calibration. */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationOverview } from '../../services/types';
import { emptySnapshot } from '../../services/types';
import type { FanConfig } from '../../types';

let overview: CalibrationOverview;

vi.mock('../../services/dataService', () => ({
  providerInfo: () => ({ kind: 'api', mode: 'hardware', version: '1.0.0', fallbackReason: null }),
  dataService: {
    lastError: () => null,
    getSnapshot: () => emptySnapshot(),
    subscribe: () => () => {},
    start: () => {},
    calibration: {
      load: () => Promise.resolve(overview),
      discover: () => Promise.resolve({ pwmOutputs: [], tempSensors: [], warnings: [], records: [] }),
      start: vi.fn(), identify: vi.fn(), confirmIdentification: vi.fn(),
      testRpm: vi.fn(), detectMinimum: vi.fn(), testSoftwareControl: vi.fn(), testBiosReturn: vi.fn(),
      authorize: vi.fn(), cancel: vi.fn(), emergencyStop: vi.fn(), reset: vi.fn(),
    },
  },
}));

import { CalibrationWizard } from './CalibrationWizard';
import { useLiveStore } from '../../store/useLiveStore';

function baseFanConfig(overrides: Partial<FanConfig> = {}): FanConfig {
  return {
    id: 'CPU_FAN1', displayName: 'Ventirad CPU', assignedHardware: 'cpu',
    sensor: { kind: 'single', source: 'cpu' }, mode: 'auto',
    manualPwm: 40, minPwm: 15, warnRpm: 300, curve: [],
    monitoringOnly: false,
    ...overrides,
  };
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    fanId: 'CPU_FAN1', state: 'FAILED', outputKey: 'nct6795:x#pwm2', controllerKey: null,
    controllerDriver: null, controllerAddress: null, pwmIndex: null, tachIndex: null,
    lastPwmPath: null, lastTachPath: null, assignedHardware: 'cpu', customHardwareLabel: null,
    rpmValidation: 'INCONSISTENT', startupPwm: null, minimumPwm: null, minRpmObserved: null,
    maxRpmObserved: null, softwareControlValidated: false, biosReturn: null, biosEnableMode: null,
    manualEnableMode: null, biosVersion: null, kernelVersion: null, calibratedAt: null,
    notes: null, invalidatedReason: null,
    ...overrides,
  } as CalibrationOverview['records'][number];
}

beforeEach(() => {
  useLiveStore.setState((s) => ({
    snap: {
      ...s.snap, backendConnected: true, time: Date.now(),
      system: { ...(s.snap.system ?? {}), mode: 'hardware', fanEngine: { online: true } } as never,
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supervision tachymétrique uniquement (monitoring_only)', () => {
  it('masque le bouton « Autoriser » et affiche le message dédié', async () => {
    overview = {
      records: [baseRecord()],
      sessions: [],
      engineOnline: true,
      requireBiosReturnValidation: true,
      fanConfigs: [baseFanConfig({ monitoringOnly: true })],
    };

    render(<CalibrationWizard fanId="CPU_FAN1" displayName="Ventirad CPU" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Supervision tachymétrique uniquement/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Autoriser cette sortie' })).not.toBeInTheDocument();
  });

  it('affiche normalement le bouton « Autoriser » quand monitoringOnly est faux', async () => {
    overview = {
      records: [baseRecord({
        state: 'BIOS_RETURN_VALIDATED', rpmValidation: 'CONFIRMED', minimumPwm: 30,
        softwareControlValidated: true, biosReturn: 'CONFIRMED',
      })],
      sessions: [],
      engineOnline: true,
      requireBiosReturnValidation: true,
      fanConfigs: [baseFanConfig({ monitoringOnly: false })],
    };

    render(<CalibrationWizard fanId="CPU_FAN1" displayName="Ventirad CPU" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Autoriser cette sortie' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Supervision tachymétrique uniquement/)).not.toBeInTheDocument();
  });
});
