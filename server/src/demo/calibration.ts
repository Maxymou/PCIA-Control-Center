/** Calibration pré-remplie du mode démonstration.
 *
 *  En mode démo, tout est simulé et annoncé comme tel : on peut donc livrer des
 *  sorties déjà « calibrées » pour que l'application soit immédiatement
 *  utilisable, sans avoir à dérouler l'assistant sur du matériel inexistant.
 *
 *  Cette fonction ne fait **rien** en mode matériel : sur une vraie machine,
 *  aucune sortie ne devient AUTHORIZED sans calibration réelle.
 */

import type { CalibrationRecord, FanId } from '../contract.js';
import { emptyCalibration, type Repositories } from '../db/repositories.js';
import { createLogger } from '../logger.js';
import type { SimulatedHwmonBackend } from '../hwmon/simulated.js';
import { SIM_MODE_BIOS, SIM_MODE_MANUAL } from '../hwmon/simulated.js';
import { readSystemInfo } from '../system/info.js';
import { PASSIVE_COOLING_FANS } from '../fan/defaults.js';

const log = createLogger('demo.calibration');

/** Le simulateur nomme ses sorties comme les sorties logiques attendues. */
const SIM_LABELS: Record<FanId, string> = {
  CPU_FAN1: 'CPU_FAN1',
  SYS_FAN1: 'SYS_FAN1',
  SYS_FAN2: 'SYS_FAN2',
  SYS_FAN3: 'SYS_FAN3',
  SYS_FAN4: 'SYS_FAN4',
};

const ASSIGNMENTS: Record<FanId, CalibrationRecord['assignedHardware']> = {
  CPU_FAN1: 'cpu',
  SYS_FAN1: 'case-front',
  SYS_FAN2: 'case-rear',
  SYS_FAN3: 'v100-1',
  SYS_FAN4: 'v100-2',
};

export function seedDemoCalibration(repos: Repositories, hwmon: SimulatedHwmonBackend): void {
  if (repos.settings.get<boolean>('demoCalibrationSeeded', false)) return;
  const info = readSystemInfo();
  let seeded = 0;

  for (const [fanId, label] of Object.entries(SIM_LABELS) as [FanId, string][]) {
    const outputKey = hwmon.outputKeyByLabel(label);
    if (!outputKey) continue;
    const output = hwmon.getOutput(outputKey);
    if (!output) continue;

    const record: CalibrationRecord = {
      ...emptyCalibration(fanId),
      state: 'AUTHORIZED',
      outputKey,
      controllerKey: output.controller.key,
      controllerDriver: output.controller.driverName,
      controllerAddress: output.controller.address,
      pwmIndex: output.index,
      tachIndex: output.tachIndex,
      lastPwmPath: output.pwmPath,
      lastTachPath: output.tachPath,
      assignedHardware: ASSIGNMENTS[fanId],
      rpmValidation: 'CONFIRMED',
      startupPwm: PASSIVE_COOLING_FANS.includes(fanId) ? 20 : 12,
      minimumPwm: PASSIVE_COOLING_FANS.includes(fanId) ? 35 : 20,
      minRpmObserved: 300,
      maxRpmObserved: 2800,
      softwareControlValidated: true,
      biosReturn: 'CONFIRMED',
      biosEnableMode: SIM_MODE_BIOS,
      manualEnableMode: SIM_MODE_MANUAL,
      biosVersion: info.biosVersion,
      kernelVersion: info.kernel,
      calibratedAt: Date.now(),
      notes: 'Calibration simulée — mode démonstration uniquement.',
      invalidatedReason: null,
    };
    repos.calibration.save(record);
    seeded++;
  }

  repos.settings.set('demoCalibrationSeeded', true);
  log.info('Calibration de démonstration pré-remplie', { outputs: seeded });
}
