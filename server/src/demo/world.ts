/** Monde simulé du mode démonstration.
 *
 *  Objectif : permettre d'utiliser l'application complète sur une machine sans
 *  hwmon, sans GPU NVIDIA et sans privilège — y compris les scénarios du
 *  panneau de démonstration du front-end existant.
 *
 *  Le mode démo est **toujours annoncé** : `system.mode = 'demo'`. Aucune donnée
 *  simulée n'est jamais servie en mode matériel.
 */

import type {
  Connection, ConnectionType, HardwareId, Service, ServiceStatus, ServiceType,
} from '../contract.js';
import type { GpuInfo } from '../hardware/gpu.js';
import type { StorageSummary } from '../hardware/storage.js';
import type { SimulatedHwmonBackend } from '../hwmon/simulated.js';
import { CONFIDENCE_VALUES, type DetectedConnection, type DetectedService } from '../discovery/model.js';

/** Températures d'équilibre au repos, par emplacement. */
const BASE_TEMPS: Record<string, number> = {
  cpu: 46,
  nvme: 42,
  'v100-1': 58,
  'v100-2': 60,
  gtx1080: 38,
  motherboard: 36,
  'case-front': 30,
  'case-rear': 33,
};

/** Sensibilité de chaque emplacement au débit d'air de sa sortie. */
const COOLING_LINK: Partial<Record<HardwareId, { fanLabel: string; strength: number }>> = {
  cpu: { fanLabel: 'CPU_FAN1', strength: 22 },
  'v100-1': { fanLabel: 'SYS_FAN3', strength: 30 },
  'v100-2': { fanLabel: 'SYS_FAN4', strength: 30 },
  gtx1080: { fanLabel: 'SYS_FAN1', strength: 10 },
  nvme: { fanLabel: 'SYS_FAN1', strength: 8 },
  motherboard: { fanLabel: 'SYS_FAN2', strength: 8 },
  'case-front': { fanLabel: 'SYS_FAN1', strength: 6 },
  'case-rear': { fanLabel: 'SYS_FAN2', strength: 6 },
};

const GPU_UUIDS = {
  'v100-1': 'GPU-11111111-2222-3333-4444-555555555551',
  'v100-2': 'GPU-11111111-2222-3333-4444-555555555552',
  gtx1080: 'GPU-99999999-8888-7777-6666-555555555553',
};

const GPU_PCI = {
  'v100-1': '00000000:17:00.0',
  'v100-2': '00000000:65:00.0',
  gtx1080: '00000000:b3:00.0',
};

interface DemoService extends DetectedService {
  /** Charge GPU induite, utilisée pour faire varier les températures. */
  gpuLoad?: number;
}

export interface DemoScenarioState {
  gtxInstalled: boolean;
  backendConnected: boolean;
  v100Overheat: boolean;
  fanBlocked: boolean;
  openWebUiDown: boolean;
  vllmLinkLost: boolean;
  grafanaDetected: boolean;
  conflictInjected: boolean;
  nvmeAlert: boolean;
}

export class DemoWorld {
  private temps: Record<string, number> = { ...BASE_TEMPS };
  private gpuLoad = { 'v100-1': 68, 'v100-2': 74, gtx1080: 6 };
  private scenario: DemoScenarioState = {
    gtxInstalled: true,
    backendConnected: true,
    v100Overheat: false,
    fanBlocked: false,
    openWebUiDown: false,
    vllmLinkLost: false,
    grafanaDetected: false,
    conflictInjected: false,
    nvmeAlert: false,
  };
  private hwmon: SimulatedHwmonBackend | null = null;
  private lastStep = Date.now();

  constructor(opts: { gtxInstalled?: boolean } = {}) {
    if (opts.gtxInstalled !== undefined) this.scenario.gtxInstalled = opts.gtxInstalled;
  }

  attachHwmon(hwmon: SimulatedHwmonBackend): void {
    this.hwmon = hwmon;
    hwmon.setTemperatureProvider((source) => this.readTemp(source));
  }

  state(): DemoScenarioState {
    return { ...this.scenario };
  }

  // ---------- Physique thermique ----------

  /** Avance la simulation : la température dépend de la charge et du débit d'air. */
  step(now = Date.now()): void {
    const dt = Math.min(5000, now - this.lastStep);
    this.lastStep = now;
    if (dt <= 0) return;
    this.hwmon?.step(dt);
    const alpha = Math.min(1, dt / 8000);

    for (const id of Object.keys(BASE_TEMPS) as HardwareId[]) {
      if (id === 'gtx1080' && !this.scenario.gtxInstalled) continue;
      const link = COOLING_LINK[id];
      const pwm = link ? this.fanPwm(link.fanLabel) : 50;
      const loadFactor = id.startsWith('v100') || id === 'gtx1080'
        ? this.gpuLoad[id as keyof typeof this.gpuLoad] / 100
        : id === 'cpu' ? 0.45 : 0.3;

      // Cible : base + apport de charge − refroidissement proportionnel au PWM.
      let target = BASE_TEMPS[id] + loadFactor * 34 - (link ? (pwm / 100) * link.strength : 0);
      if (this.scenario.v100Overheat && id === 'v100-2') target = 92;
      if (this.scenario.fanBlocked && id === 'v100-2') target += 12;

      const noise = (Math.random() - 0.5) * 0.6;
      this.temps[id] = Math.round((this.temps[id] + (target - this.temps[id]) * alpha + noise) * 10) / 10;
    }

    // Dérive douce des charges GPU.
    for (const k of Object.keys(this.gpuLoad) as (keyof typeof this.gpuLoad)[]) {
      const base = this.scenario.openWebUiDown && k !== 'gtx1080' ? 20 : k === 'gtx1080' ? 6 : 72;
      this.gpuLoad[k] = Math.max(0, Math.min(100, Math.round(this.gpuLoad[k] + (base - this.gpuLoad[k]) * 0.08 + (Math.random() - 0.5) * 4)));
    }
  }

  private fanPwm(label: string): number {
    if (!this.hwmon) return 50;
    const key = this.hwmon.outputKeyByLabel(label);
    if (!key) return 50;
    const out = this.hwmon.getOutput(key);
    // En mode BIOS simulé, la consigne effective n'est pas celle qu'on a écrite.
    if (out?.currentEnableMode === 1) return this.hwmon.readPwmPercent(key) ?? 50;
    return Math.max(this.hwmon.readPwmPercent(key) ?? 40, 40);
  }

  readTemp(source: string): number | null {
    if (source === 'gtx1080' && !this.scenario.gtxInstalled) return null;
    const v = this.temps[source];
    return v === undefined ? null : v;
  }

  // ---------- Fournisseurs pour l'inventaire ----------

  async gpus(): Promise<{ gpus: GpuInfo[]; available: boolean }> {
    const slots: (keyof typeof GPU_UUIDS)[] = ['v100-1', 'v100-2', 'gtx1080'];
    const list: GpuInfo[] = [];
    for (const slot of slots) {
      if (slot === 'gtx1080' && !this.scenario.gtxInstalled) continue;
      const isV100 = slot !== 'gtx1080';
      list.push({
        uuid: GPU_UUIDS[slot],
        name: isV100 ? 'Tesla V100-PCIE-32GB' : 'NVIDIA GeForce GTX 1080',
        pciBusId: GPU_PCI[slot],
        pcieSlot: `PCIe ${GPU_PCI[slot].split(':')[1]}:00`,
        tempC: this.temps[slot],
        utilizationPercent: this.gpuLoad[slot],
        memoryUsedGb: isV100
          ? Math.round((this.gpuLoad[slot] / 100) * 30 * 10) / 10
          : Math.round((this.gpuLoad[slot] / 100) * 7 * 10) / 10,
        memoryTotalGb: isV100 ? 32 : 8,
        powerW: Math.round(50 + (this.gpuLoad[slot] / 100) * (isV100 ? 200 : 130)),
        powerLimitW: isV100 ? 250 : 180,
        driverVersion: '550.90.07',
        cudaVersion: '12.4',
        state: 'Active',
        processes: this.scenario.openWebUiDown || !isV100 ? [] : [
          { pid: 4821, name: 'python3 (vllm)', usedMemoryMb: 24_500 },
        ],
      });
    }
    return { gpus: list, available: true };
  }

  async storage(): Promise<StorageSummary> {
    return {
      devices: [{
        device: 'nvme0n1',
        model: 'Samsung SSD 990 PRO 2TB (simulé)',
        serial: 'S6XXNXXXXXXXXXX',
        firmware: '4B2QJXD7',
        capacityGb: 2000,
        tempC: this.temps.nvme,
        healthPercent: 97,
        smartOk: true,
        mediaErrors: 0,
        powerOnHours: 4210,
      }],
      primary: {
        device: 'nvme0n1',
        model: 'Samsung SSD 990 PRO 2TB (simulé)',
        serial: 'S6XXNXXXXXXXXXX',
        firmware: '4B2QJXD7',
        capacityGb: 2000,
        tempC: this.temps.nvme,
        healthPercent: 97,
        smartOk: true,
        mediaErrors: 0,
        powerOnHours: 4210,
      },
      rootCapacityGb: 2000,
      rootUsedGb: 1240,
      activityPercent: this.scenario.nvmeAlert ? 92 : Math.round(8 + Math.random() * 10),
    };
  }

  // ---------- Services et connexions simulés ----------

  private makeService(
    id: string, name: string, displayName: string, type: ServiceType,
    status: ServiceStatus, extra: Partial<DemoService> = {},
  ): DemoService {
    return {
      id, name, displayName, type, status,
      origin: 'detected', lastCheck: Date.now(),
      source: extra.dockerContainer ? 'docker' : 'systemd',
      category: extra.category ?? 'application',
      hiddenByDefault: false,
      pid: extra.pid ?? null,
      systemdUnit: extra.systemdUnit ?? null,
      dockerContainer: extra.dockerContainer ?? null,
      dockerImage: extra.dockerImage ?? null,
      ports: extra.ports ?? [],
      startedAt: extra.startedAt ?? Date.now() - 3_600_000,
      uptimeSeconds: 3600,
      cpuPercent: extra.cpuPercent ?? null,
      memoryMb: extra.memoryMb ?? null,
      metadata: extra.metadata ?? {},
      ...extra,
    } as DemoService;
  }

  services(): DetectedService[] {
    const now = Date.now();
    const list: DemoService[] = [
      this.makeService('svc-demo-pcia', 'pcia-control-center', 'PCIA Control Center', 'ui', 'running', {
        category: 'important', port: 4321, address: '0.0.0.0', ports: [4321],
        systemdUnit: 'pcia-control-center.service', version: '1.0.0', process: 'node',
        note: 'Interface de supervision (cette application).',
      }),
      this.makeService('svc-demo-fand', 'pcia-fand', 'Moteur de ventilation', 'fan-control', 'running', {
        category: 'important', systemdUnit: 'pcia-fan-control.service', version: '1.0.0', process: 'pcia-fand',
        note: 'Boucle de régulation indépendante. Accès sysfs/hwmon.',
      }),
      this.makeService('svc-demo-docker', 'docker', 'Docker Engine', 'docker', 'running', {
        category: 'important', systemdUnit: 'docker.service', version: '27.3.1', process: 'dockerd',
      }),
      this.makeService('svc-demo-vllm', 'vllm', 'vLLM', 'llm', 'running', {
        category: 'ai', dockerContainer: 'vllm-server', dockerImage: 'vllm/vllm-openai:v0.8.4',
        port: 8000, address: '127.0.0.1', ports: [8000], version: '0.8.4',
        note: 'Modèle chargé : Hermes-3-Llama-3.1-70B (2× V100).',
      }),
      this.makeService('svc-demo-openwebui', 'open-webui', 'OpenWebUI', 'webui',
        this.scenario.openWebUiDown ? 'crashed' : 'running', {
          category: 'ai', dockerContainer: 'open-webui', dockerImage: 'ghcr.io/open-webui/open-webui:main',
          port: 3000, address: '0.0.0.0', ports: [3000], version: '0.6.5',
        }),
      this.makeService('svc-demo-hermes', 'hermes-agent', 'Hermes', 'llm', 'stopped', {
        category: 'ai', dockerContainer: 'hermes', dockerImage: 'hermes/agent:2.1.0', version: '2.1.0',
        note: 'Arrêté volontairement — libère de la VRAM pour vLLM.',
      }),
      this.makeService('svc-demo-postgres', 'postgres', 'PostgreSQL', 'database', 'running', {
        category: 'application', dockerContainer: 'postgres', dockerImage: 'postgres:16.4',
        port: 5432, address: '127.0.0.1', ports: [5432], version: '16.4',
      }),
      this.makeService('svc-demo-caddy', 'caddy', 'Reverse proxy', 'proxy', 'running', {
        category: 'network', systemdUnit: 'caddy.service', port: 443, address: '0.0.0.0', ports: [443, 80], version: '2.9.1',
      }),
      this.makeService('svc-demo-nodeexp', 'node-exporter', 'Node Exporter', 'system', 'unreachable', {
        category: 'application', port: 9100, address: '127.0.0.1', ports: [9100], version: '1.8.2',
        lastCheck: now - 120_000,
      }),
      this.makeService('svc-demo-sshd', 'ssh', 'OpenSSH Server', 'system', 'running', {
        category: 'important', systemdUnit: 'ssh.service', port: 22, address: '0.0.0.0', ports: [22],
      }),
      this.makeService('svc-demo-systemd-logind', 'systemd-logind', 'Gestion des sessions', 'system', 'running', {
        category: 'system', systemdUnit: 'systemd-logind.service', hiddenByDefault: true,
      }),
      this.makeService('svc-demo-cron', 'cron', 'Tâches planifiées', 'system', 'running', {
        category: 'system', systemdUnit: 'cron.service', hiddenByDefault: true,
      }),
    ];

    if (this.scenario.grafanaDetected) {
      list.push(this.makeService('svc-demo-grafana', 'grafana', 'Grafana', 'webui', 'running', {
        category: 'application', dockerContainer: 'grafana', dockerImage: 'grafana/grafana:11.5.0',
        port: 3001, address: '0.0.0.0', ports: [3001], version: '11.5.0',
      }));
    }
    return list;
  }

  connections(): DetectedConnection[] {
    const now = Date.now();
    const make = (
      id: string, sourceId: string, targetId: string, type: ConnectionType,
      level: 'LOW' | 'MEDIUM' | 'HIGH', method: DetectedConnection['detectionMethod'],
      extra: Partial<DetectedConnection> = {},
    ): DetectedConnection => ({
      id, sourceId, targetId, type,
      status: extra.status ?? 'active',
      origin: 'detected',
      confidence: CONFIDENCE_VALUES[level],
      lastActivity: now,
      direction: extra.direction ?? 'outbound',
      detectionMethod: method,
      confidenceLevel: level,
      remoteAddress: extra.remoteAddress ?? '127.0.0.1',
      lastObserved: now,
      hiddenByDefault: extra.hiddenByDefault ?? false,
      metadata: extra.metadata ?? {},
      ...extra,
    });

    const list: DetectedConnection[] = [
      make('cx-demo-1', 'svc-demo-pcia', 'svc-demo-fand', 'pwm', 'HIGH', 'tcp-socket', {
        note: 'Consignes PWM transmises via socket Unix.',
      }),
      make('cx-demo-2', 'svc-demo-fand', 'svc-demo-pcia', 'sensor', 'HIGH', 'tcp-socket', {
        direction: 'inbound',
      }),
      make('cx-demo-3', 'svc-demo-openwebui', 'svc-demo-vllm', 'openai-api', 'HIGH', 'tcp-socket', {
        protocol: 'HTTP', port: 8000, endpoint: '/v1/chat/completions',
        status: this.scenario.vllmLinkLost ? 'lost' : this.scenario.openWebUiDown ? 'unknown' : 'active',
      }),
      make('cx-demo-4', 'svc-demo-docker', 'svc-demo-vllm', 'docker', 'HIGH', 'docker-runtime'),
      make('cx-demo-5', 'svc-demo-docker', 'svc-demo-openwebui', 'docker', 'HIGH', 'docker-runtime', {
        status: this.scenario.openWebUiDown ? 'degraded' : 'active',
      }),
      make('cx-demo-6', 'svc-demo-docker', 'svc-demo-hermes', 'docker', 'HIGH', 'docker-runtime', { status: 'unknown' }),
      make('cx-demo-7', 'svc-demo-docker', 'svc-demo-postgres', 'docker', 'HIGH', 'docker-runtime'),
      make('cx-demo-8', 'svc-demo-openwebui', 'svc-demo-postgres', 'database', 'HIGH', 'tcp-socket', {
        protocol: 'PostgreSQL', port: 5432,
        status: this.scenario.openWebUiDown ? 'lost' : 'degraded',
        note: 'Latences élevées observées depuis 10 min.',
      }),
      make('cx-demo-9', 'svc-demo-caddy', 'svc-demo-openwebui', 'https', 'HIGH', 'tcp-socket', {
        protocol: 'HTTPS', port: 3000,
      }),
      make('cx-demo-10', 'svc-demo-pcia', 'svc-demo-nodeexp', 'http', 'MEDIUM', 'known-endpoint', {
        port: 9100, endpoint: '/metrics', status: 'lost', lastActivity: now - 120_000,
      }),
      make('cx-demo-11', 'svc-demo-hermes', 'svc-demo-vllm', 'openai-api', 'MEDIUM', 'environment', {
        port: 8000, status: 'unknown',
        note: 'Déduite d’une variable d’environnement — trafic non observé.',
      }),
      make('cx-demo-12', 'svc-demo-vllm', 'svc-demo-postgres', 'network', 'LOW', 'docker-network', {
        status: 'unknown', hiddenByDefault: true,
        note: 'Même réseau Docker (ia-net) — communication possible, non observée.',
      }),
    ];

    if (this.scenario.grafanaDetected) {
      list.push(make('cx-demo-grafana', 'svc-demo-grafana', 'svc-demo-postgres', 'database', 'HIGH', 'tcp-socket', {
        port: 5432, status: 'new',
      }));
    }
    return list;
  }

  // ---------- Déclencheurs du panneau de démonstration ----------

  trigger(name: string): { ok: boolean; message: string } {
    switch (name) {
      case 'heatUpV100':
        this.scenario.v100Overheat = true;
        return { ok: true, message: 'Montée en température simulée sur la Tesla V100 n°2.' };
      case 'blockFan':
        this.scenario.fanBlocked = true;
        this.hwmon?.setStalled('SYS_FAN4', true);
        return { ok: true, message: 'Blocage mécanique simulé sur SYS_FAN4.' };
      case 'stopService':
        this.scenario.openWebUiDown = true;
        return { ok: true, message: 'Arrêt inattendu simulé d’OpenWebUI.' };
      case 'loseConnection':
        this.scenario.vllmLinkLost = true;
        return { ok: true, message: 'Perte de connexion simulée OpenWebUI → vLLM.' };
      case 'detectNewService':
        this.scenario.grafanaDetected = true;
        return { ok: true, message: 'Nouveau service simulé : Grafana.' };
      case 'conflictingDetection':
        this.scenario.conflictInjected = true;
        return { ok: true, message: 'Détection contradictoire injectée.' };
      case 'toggleGtx':
        this.scenario.gtxInstalled = !this.scenario.gtxInstalled;
        return {
          ok: true,
          message: this.scenario.gtxInstalled ? 'GTX 1080 simulée installée.' : 'GTX 1080 simulée retirée.',
        };
      case 'newAlert':
        this.scenario.nvmeAlert = true;
        return { ok: true, message: 'Activité NVMe inhabituelle simulée.' };
      case 'toggleBackend':
        this.scenario.backendConnected = !this.scenario.backendConnected;
        return {
          ok: true,
          message: this.scenario.backendConnected ? 'Back-end simulé reconnecté.' : 'Back-end simulé déconnecté.',
        };
      case 'backToNormal':
        this.scenario.v100Overheat = false;
        this.scenario.fanBlocked = false;
        this.scenario.openWebUiDown = false;
        this.scenario.vllmLinkLost = false;
        this.scenario.nvmeAlert = false;
        this.scenario.backendConnected = true;
        this.hwmon?.setStalled('SYS_FAN4', false);
        return { ok: true, message: 'Retour à l’état normal simulé.' };
      case 'reset':
        this.scenario = {
          gtxInstalled: true, backendConnected: true, v100Overheat: false, fanBlocked: false,
          openWebUiDown: false, vllmLinkLost: false, grafanaDetected: false,
          conflictInjected: false, nvmeAlert: false,
        };
        this.temps = { ...BASE_TEMPS };
        this.hwmon?.setStalled('SYS_FAN4', false);
        return { ok: true, message: 'Scénarios de démonstration réinitialisés.' };
      default:
        return { ok: false, message: `Scénario inconnu : ${name}` };
    }
  }

  /** La connexion « corrigée » sur laquelle injecter un conflit. */
  conflictTarget(): { connectionId: string; detected: Pick<Connection, 'sourceId' | 'targetId' | 'type' | 'port' | 'endpoint'> } | null {
    if (!this.scenario.conflictInjected) return null;
    return {
      connectionId: 'cx-demo-11',
      detected: { sourceId: 'svc-demo-vllm', targetId: 'svc-demo-hermes', type: 'openai-api', port: 8000 },
    };
  }

  backendConnected(): boolean {
    return this.scenario.backendConnected;
  }

  /** Services et connexions au format brut, tels que le collecteur les attend. */
  isGtxInstalled(): boolean {
    return this.scenario.gtxInstalled;
  }
}

/** Liste des scénarios exposés par l'API (le panneau du front-end les appelle). */
export const DEMO_SCENARIOS = [
  'heatUpV100', 'blockFan', 'stopService', 'loseConnection', 'detectNewService',
  'conflictingDetection', 'toggleGtx', 'newAlert', 'toggleBackend', 'backToNormal', 'reset',
] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

/** Types réexportés pour lever toute ambiguïté à l'usage. */
export type { DetectedConnection, DetectedService, Service };
