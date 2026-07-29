/** Hôte du moteur de ventilation.
 *
 *  Assemble : moteur, assistant de calibration, canal de commande et fichier
 *  d'état. Utilisé aussi bien par le daemon `pcia-fand` que par le moteur
 *  embarqué dans l'API (mode mono-processus).
 *
 *  Un **verrou exclusif** garantit qu'un seul hôte pilote les PWM à la fois.
 */

import type { AppConfig } from '../config.js';
import { fanSocketPath, fanStatePath } from '../config.js';
import type { FanEngineState, FanId, HardwareId } from '../contract.js';
import { FAN_IDS } from '../contract.js';
import type { Repositories } from '../db/repositories.js';
import { createLogger } from '../logger.js';
import type { HwmonBackend } from '../hwmon/backend.js';
import { CalibrationController } from './calibration.js';
import { FanEngine, type EngineAlert, type EngineEvent } from './engine.js';
import { FanIpcServer, writeStateFile, type IpcCommand } from './ipc.js';
import { acquireFanLock, type FanLock } from './lock.js';
import { SensorSource } from './sensorSource.js';
import type { GpuInfo } from '../hardware/gpu.js';

const log = createLogger('fan.host');

export interface FanHostOptions {
  config: AppConfig;
  repos: Repositories;
  hwmon: HwmonBackend;
  mode: 'hardware' | 'demo';
  gpuProvider?: () => Promise<{ gpus: GpuInfo[]; available: boolean }>;
  /** Démarre le canal de commande (faux pour les tests unitaires). */
  withIpc?: boolean;
  /** Publie le fichier d'état runtime. */
  withStateFile?: boolean;
  onState?: (state: FanEngineState) => void;
  onEvent?: (event: EngineEvent) => void;
  onAlert?: (alert: EngineAlert) => void;
}

export class FanHost {
  readonly engine: FanEngine;
  readonly calibration: CalibrationController;
  private ipc: FanIpcServer | null = null;
  private lock: FanLock | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private lastState: FanEngineState | null = null;

  constructor(private opts: FanHostOptions) {
    const sensors = new SensorSource({
      hwmon: opts.hwmon,
      overrides: () => opts.repos.settings.get<Partial<Record<HardwareId, string>>>('sensorOverrides', {}),
      gpuSlots: () => opts.repos.settings.get('gpuSlots', {}),
      gpuProvider: opts.gpuProvider,
    });

    this.engine = new FanEngine({
      config: opts.config,
      hwmon: opts.hwmon,
      repos: opts.repos,
      sensors,
      mode: opts.mode,
      onEvent: (e) => this.handleEvent(e),
      onAlert: (a) => this.handleAlert(a),
      onState: (s) => {
        this.lastState = s;
        opts.onState?.(s);
      },
    });

    this.calibration = new CalibrationController({
      engine: this.engine,
      repos: opts.repos,
      onUpdate: () => {
        // La progression de calibration doit remonter sans attendre le cycle.
        if (this.lastState) opts.onState?.(this.engine.state());
      },
    });
  }

  /** Tente d'acquérir le verrou puis démarre. Renvoie `false` si un autre
   *  moteur détient déjà le contrôle — dans ce cas rien n'est démarré. */
  start(): { started: boolean; heldBy: number | null } {
    const attempt = acquireFanLock(this.opts.config.storage.runtimeDir);
    if (!attempt.acquired) {
      log.warn('Un autre moteur de ventilation détient le contrôle', { pid: attempt.heldBy });
      return { started: false, heldBy: attempt.heldBy };
    }
    this.lock = attempt.lock;

    this.engine.start();

    if (this.opts.withIpc !== false) {
      this.ipc = new FanIpcServer(fanSocketPath(this.opts.config), (command, params) => this.handleCommand(command, params));
      this.ipc.start();
    }

    if (this.opts.withStateFile !== false) {
      const path = fanStatePath(this.opts.config);
      const publish = () => writeStateFile(path, this.engine.state());
      publish();
      this.stateTimer = setInterval(publish, this.opts.config.fanControl.heartbeatIntervalMs);
    }

    return { started: true, heldBy: process.pid };
  }

  async stop(): Promise<void> {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = null;
    this.ipc?.stop();
    this.ipc = null;
    await this.engine.shutdown();
    this.lock?.release();
    this.lock = null;
  }

  state(): FanEngineState {
    return this.engine.state();
  }

  /** Permet à l'API de suivre l'état du moteur embarqué en temps réel. */
  setStateListener(listener: (state: FanEngineState) => void): void {
    this.opts.onState = listener;
  }

  // =====================================================================
  // Journalisation et alertes → base
  // =====================================================================

  private handleEvent(e: EngineEvent): void {
    try {
      this.opts.repos.events.append({
        category: e.category === 'temperature' ? 'temperature' : e.category === 'hardware' ? 'hardware' : e.category,
        level: e.level,
        targetLabel: e.targetLabel,
        message: e.message,
        metadata: e.metadata,
      });
    } catch (err) {
      log.error('Journalisation d’événement impossible', { error: err });
    }
    this.opts.onEvent?.(e);
  }

  private handleAlert(a: EngineAlert): void {
    try {
      if (!a.active) {
        this.opts.repos.alerts.resolve('fan', a.fanId, a.type === 'CRITICAL_TEMPERATURE' ? 'CRITICAL_TEMPERATURE' : a.type);
      } else {
        this.opts.repos.alerts.raise({
          type: a.type,
          level: a.level,
          targetKind: 'fan',
          targetId: a.fanId,
          targetLabel: a.label,
          message: a.message,
          value: a.value,
          threshold: a.threshold,
          recommendation: a.recommendation,
        });
      }
    } catch (err) {
      log.error('Enregistrement d’alerte impossible', { error: err });
    }
    this.opts.onAlert?.(a);
  }

  // =====================================================================
  // Commandes
  // =====================================================================

  private fanIdParam(params: Record<string, unknown>): FanId {
    const raw = String(params.fanId ?? '');
    if (!(FAN_IDS as readonly string[]).includes(raw)) {
      throw new Error(`Sortie inconnue : ${raw}`);
    }
    return raw as FanId;
  }

  async handleCommand(command: IpcCommand, params: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'ping':
        return { pong: true, pid: process.pid };
      case 'getState':
        return this.engine.state();
      case 'reload':
        this.engine.rediscover();
        return { ok: true };
      case 'rediscover':
        this.engine.rediscover();
        return this.opts.hwmon.cached();

      case 'startTest': {
        const seconds = Number(params.seconds ?? 30);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) {
          throw new Error('Durée de test invalide (1–120 s).');
        }
        return this.engine.startTest(this.fanIdParam(params), seconds);
      }
      case 'stopTest':
        return this.engine.stopTest(this.fanIdParam(params));
      case 'forceMax': {
        const seconds = params.seconds === undefined ? undefined : Number(params.seconds);
        if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600)) {
          throw new Error('Durée de forçage invalide (1–600 s).');
        }
        return this.engine.forceMax(this.fanIdParam(params), seconds);
      }
      case 'clearForceMax':
        this.engine.clearForceMax(this.fanIdParam(params));
        return { ok: true };
      case 'returnToBios':
        return this.engine.requestReturnToBios(this.fanIdParam(params));
      case 'takeSoftwareControl':
        return this.engine.requestSoftwareControl(this.fanIdParam(params));

      case 'calibration.discover':
        return this.calibration.discover();
      case 'calibration.sessions':
        return this.calibration.sessionsList();
      case 'calibration.start': {
        const outputKey = String(params.outputKey ?? '');
        if (!outputKey) throw new Error('Sortie PWM non précisée.');
        return this.calibration.start(this.fanIdParam(params), outputKey);
      }
      case 'calibration.identify':
        return this.calibration.identify(this.fanIdParam(params));
      case 'calibration.confirmIdentification':
        return this.calibration.confirmIdentification(this.fanIdParam(params), {
          assignedHardware: params.assignedHardware as HardwareId | 'none' | 'custom',
          customLabel: params.customLabel as string | undefined,
          tachKey: (params.tachKey as string | null | undefined) ?? null,
          inconclusive: Boolean(params.inconclusive),
        });
      case 'calibration.testRpm':
        return this.calibration.testRpm(this.fanIdParam(params));
      case 'calibration.detectMinimum':
        return this.calibration.detectMinimum(this.fanIdParam(params));
      case 'calibration.testSoftwareControl':
        return this.calibration.testSoftwareControl(this.fanIdParam(params));
      case 'calibration.testBiosReturn':
        return this.calibration.testBiosReturn(this.fanIdParam(params));
      case 'calibration.authorize':
        return this.calibration.authorize(this.fanIdParam(params), {
          acceptRestricted: Boolean(params.acceptRestricted),
        });
      case 'calibration.cancel':
        return this.calibration.cancel(this.fanIdParam(params));
      case 'calibration.emergencyStop':
        return this.calibration.emergencyStop(this.fanIdParam(params));
      case 'calibration.reset':
        this.calibration.reset(this.fanIdParam(params));
        return { ok: true };

      default:
        throw new Error(`Commande non implémentée : ${command}`);
    }
  }
}
