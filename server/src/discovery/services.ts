/** Détection des services : systemd, Docker, processus, ports en écoute.
 *
 *  Deux règles structurantes :
 *   - les identifiants sont **déterministes** (dérivés du nom d'unité ou du
 *     conteneur), pour que notes, corrections et masquages restent attachés ;
 *   - la vue principale ne doit pas être noyée : les centaines d'unités système
 *     sont classées `system` et marquées `hiddenByDefault`.
 */

import { readFileSync } from 'node:fs';
import type { ServiceStatus, ServiceType } from '../contract.js';
import { createLogger } from '../logger.js';
import { hasTool, run } from '../system/exec.js';
import {
  type DetectedService, type ServiceCategory, stableId,
} from './model.js';
import { isUnspecified, type SocketSnapshot } from './ports.js';

const log = createLogger('discovery.services');

/** Unités et conteneurs jugés significatifs pour un PC IA. */
const NOTABLE_PATTERNS: { re: RegExp; type: ServiceType; category: ServiceCategory }[] = [
  { re: /^(docker|containerd|podman)$/i, type: 'docker', category: 'important' },
  { re: /vllm|ollama|llama|text-generation|tgi|triton|localai|exllama/i, type: 'llm', category: 'ai' },
  { re: /open-?webui|chatbot-ui|lobe-?chat|anything-?llm/i, type: 'webui', category: 'ai' },
  { re: /jupyter|comfyui|automatic1111|stable-?diffusion/i, type: 'webui', category: 'ai' },
  { re: /nginx|caddy|traefik|haproxy|apache2|httpd/i, type: 'proxy', category: 'network' },
  { re: /postgres|mysql|mariadb|mongo|redis|valkey|qdrant|milvus|chroma|weaviate/i, type: 'database', category: 'application' },
  { re: /^(ssh|sshd|openssh-server)$/i, type: 'system', category: 'important' },
  { re: /pcia-control-center|pcia-fand|pcia/i, type: 'ui', category: 'important' },
  { re: /prometheus|grafana|node-?exporter|loki|telegraf/i, type: 'api', category: 'application' },
  { re: /nvidia|cuda|dcgm/i, type: 'system', category: 'important' },
  { re: /smbd|nfs|samba|avahi/i, type: 'network', category: 'network' } as never,
];

function classify(name: string, fromDocker: boolean): { type: ServiceType; category: ServiceCategory } {
  for (const p of NOTABLE_PATTERNS) {
    if (p.re.test(name)) return { type: p.type, category: fromDocker ? 'container' : p.category };
  }
  return fromDocker
    ? { type: 'docker', category: 'container' }
    : { type: 'system', category: 'system' };
}

// =====================================================================
// systemd
// =====================================================================

function systemdStatus(activeState: string, subState: string, loadState: string): ServiceStatus {
  if (loadState === 'not-found' || loadState === 'masked') return 'not-installed';
  switch (activeState) {
    case 'active':
      if (subState === 'running' || subState === 'exited') return 'running';
      if (subState === 'auto-restart') return 'restarting';
      return 'running';
    case 'activating':
      return 'starting';
    case 'deactivating':
      return 'stopped';
    case 'failed':
      return 'crashed';
    case 'inactive':
      return subState === 'auto-restart' ? 'restarting' : 'stopped';
    default:
      return 'unknown';
  }
}

interface SystemdUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

async function listSystemdUnits(): Promise<SystemdUnit[]> {
  if (!hasTool('systemctl')) return [];
  // `--output=json` existe depuis systemd 246 ; repli sur le format texte.
  const json = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--output=json'], { timeoutMs: 8000 });
  if (json.ok) {
    try {
      const parsed = JSON.parse(json.stdout) as Record<string, string>[];
      return parsed.map((u) => ({
        unit: u.unit ?? '',
        load: u.load ?? '',
        active: u.active ?? '',
        sub: u.sub ?? '',
        description: u.description ?? '',
      })).filter((u) => u.unit);
    } catch {
      /* repli texte */
    }
  }
  const text = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain'], { timeoutMs: 8000 });
  if (!text.ok) return [];
  return text.stdout.split('\n').filter((l) => l.trim()).map((line) => {
    const cols = line.trim().split(/\s+/);
    return {
      unit: cols[0] ?? '',
      load: cols[1] ?? '',
      active: cols[2] ?? '',
      sub: cols[3] ?? '',
      description: cols.slice(4).join(' '),
    };
  }).filter((u) => u.unit.endsWith('.service'));
}

/** Détails d'une unité (PID, mémoire, démarrage) — une seule invocation groupée. */
async function systemdDetails(units: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (units.length === 0 || !hasTool('systemctl')) return out;
  const props = ['Id', 'MainPID', 'MemoryCurrent', 'ExecMainStartTimestampMonotonic', 'ActiveEnterTimestamp', 'Version'];
  // `systemctl show` accepte plusieurs unités : les blocs sont séparés par une ligne vide.
  const res = await run('systemctl', ['show', ...units, `--property=${props.join(',')}`, '--no-pager'], { timeoutMs: 10_000 });
  if (!res.ok) return out;
  for (const block of res.stdout.split('\n\n')) {
    const record: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) record[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (record.Id) out.set(record.Id, record);
  }
  return out;
}

// =====================================================================
// Docker
// =====================================================================

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
}

async function listDockerContainers(): Promise<{ containers: DockerContainer[]; available: boolean }> {
  if (!hasTool('docker')) return { containers: [], available: false };
  const res = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeoutMs: 8000 });
  if (!res.ok) {
    // Docker installé mais démon arrêté / permissions : ce n'est pas une erreur critique.
    log.throttled('docker-unavailable', 600_000, 'info', 'Docker présent mais non interrogeable', { error: res.error });
    return { containers: [], available: false };
  }
  const containers: DockerContainer[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Record<string, string>;
      containers.push({
        id: j.ID ?? '',
        name: (j.Names ?? '').split(',')[0],
        image: j.Image ?? '',
        state: (j.State ?? '').toLowerCase(),
        status: j.Status ?? '',
        ports: j.Ports ?? '',
        createdAt: j.CreatedAt ?? '',
      });
    } catch {
      /* ligne non JSON */
    }
  }
  return { containers, available: true };
}

function dockerStatus(state: string, status: string): ServiceStatus {
  switch (state) {
    case 'running': return 'running';
    case 'restarting': return 'restarting';
    case 'created': return 'stopped';
    case 'paused': return 'stopped';
    case 'removing': return 'stopped';
    case 'dead': return 'error';
    case 'exited': {
      // « Exited (0) » = arrêt volontaire ; tout autre code = arrêt inattendu.
      const code = /Exited \((\d+)\)/.exec(status)?.[1];
      return code === '0' ? 'stopped' : 'crashed';
    }
    default: return 'unknown';
  }
}

function parseDockerPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const m of ports.matchAll(/:(\d+)->/g)) out.add(Number(m[1]));
  for (const m of ports.matchAll(/(\d+)\/tcp/g)) out.add(Number(m[1]));
  return [...out];
}

// =====================================================================
// Détection complète
// =====================================================================

export interface ServiceDiscoveryResult {
  services: DetectedService[];
  /** Association port en écoute → identifiant de service, pour les connexions. */
  portOwners: Map<number, string>;
  /** Association PID → identifiant de service. */
  pidOwners: Map<number, string>;
  sources: { systemd: boolean; docker: boolean; sockets: boolean };
  warnings: string[];
}

export interface ServiceDiscoveryOptions {
  sockets: SocketSnapshot;
  /** Version de l'application, pour marquer le service PCIA lui-même. */
  appVersion: string;
}

function processName(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

function processStartMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Le champ 22 (starttime) est en ticks depuis le démarrage du noyau.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    const startTicks = Number(after[19]);
    if (!Number.isFinite(startTicks)) return null;
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
    const ticksPerSec = 100; // USER_HZ, constant sur les noyaux Linux courants
    const secondsSinceBoot = startTicks / ticksPerSec;
    return Date.now() - (uptime - secondsSinceBoot) * 1000;
  } catch {
    return null;
  }
}

function processMemoryMb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

export async function discoverServices(opts: ServiceDiscoveryOptions): Promise<ServiceDiscoveryResult> {
  const warnings: string[] = [];
  const services: DetectedService[] = [];
  const portOwners = new Map<number, string>();
  const pidOwners = new Map<number, string>();
  const now = Date.now();

  // --- Docker ---
  const { containers, available: dockerAvailable } = await listDockerContainers();
  if (containers.length > 0) {
    const engineId = stableId('svc', 'docker-engine');
    services.push({
      id: engineId,
      name: 'docker',
      displayName: 'Docker Engine',
      type: 'docker',
      status: 'running',
      origin: 'detected',
      lastCheck: now,
      source: 'docker',
      category: 'important',
      hiddenByDefault: false,
      pid: null,
      systemdUnit: 'docker.service',
      dockerContainer: null,
      dockerImage: null,
      ports: [],
      startedAt: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryMb: null,
      metadata: { containers: containers.length },
    });
    pidOwners.set(-1, engineId);
  }

  for (const c of containers) {
    const id = stableId('svc', 'docker', c.name);
    const { type } = classify(`${c.name} ${c.image}`, true);
    const ports = parseDockerPorts(c.ports);
    services.push({
      id,
      name: c.name,
      displayName: c.name,
      type,
      status: dockerStatus(c.state, c.status),
      version: c.image.includes(':') ? c.image.split(':').pop() ?? undefined : undefined,
      port: ports[0],
      address: ports.length ? '0.0.0.0' : undefined,
      container: c.name,
      origin: 'detected',
      lastCheck: now,
      source: 'docker',
      category: 'container',
      hiddenByDefault: false,
      pid: null,
      systemdUnit: null,
      dockerContainer: c.name,
      dockerImage: c.image,
      ports,
      startedAt: c.createdAt ? Date.parse(c.createdAt) || null : null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryMb: null,
      metadata: { image: c.image, state: c.state, status: c.status, containerId: c.id.slice(0, 12) },
    });
    for (const p of ports) portOwners.set(p, id);
  }

  // --- systemd ---
  const units = await listSystemdUnits();
  const notableUnits = units.filter((u) => {
    const base = u.unit.replace(/\.service$/, '');
    return NOTABLE_PATTERNS.some((p) => p.re.test(base));
  });
  const details = await systemdDetails(notableUnits.map((u) => u.unit));

  for (const u of units) {
    const base = u.unit.replace(/\.service$/, '');
    // Les unités d'instance Docker font doublon avec les conteneurs.
    if (/^docker-[0-9a-f]{12,}/.test(base)) continue;
    const { type, category } = classify(base, false);
    const detail = details.get(u.unit);
    const pid = detail?.MainPID && detail.MainPID !== '0' ? Number(detail.MainPID) : null;
    const id = stableId('svc', 'systemd', u.unit);
    const memory = detail?.MemoryCurrent && detail.MemoryCurrent !== '[not set]'
      ? Math.round(Number(detail.MemoryCurrent) / 1024 / 1024)
      : pid ? processMemoryMb(pid) : null;
    const startedAt = detail?.ActiveEnterTimestamp ? Date.parse(detail.ActiveEnterTimestamp) || null : null;

    services.push({
      id,
      name: base,
      displayName: u.description || base,
      type,
      status: systemdStatus(u.active, u.sub, u.load),
      origin: 'detected',
      lastCheck: now,
      process: pid ? processName(pid) ?? undefined : undefined,
      source: 'systemd',
      category,
      // Seules les unités notables apparaissent d'emblée dans la vue principale.
      hiddenByDefault: category === 'system',
      pid,
      systemdUnit: u.unit,
      dockerContainer: null,
      dockerImage: null,
      ports: [],
      startedAt,
      uptimeSeconds: startedAt ? Math.round((now - startedAt) / 1000) : null,
      cpuPercent: null,
      memoryMb: Number.isFinite(memory as number) ? memory : null,
      metadata: { load: u.load, active: u.active, sub: u.sub, description: u.description },
    });
    if (pid) pidOwners.set(pid, id);
  }

  // --- Ports en écoute non encore attribués ---
  for (const sock of opts.sockets.listening) {
    if (portOwners.has(sock.localPort)) continue;
    const ownerId = sock.pid !== null ? pidOwners.get(sock.pid) : undefined;
    if (ownerId) {
      portOwners.set(sock.localPort, ownerId);
      const svc = services.find((s) => s.id === ownerId);
      if (svc) {
        svc.ports = [...new Set([...svc.ports, sock.localPort])];
        svc.port ??= sock.localPort;
        svc.address ??= isUnspecified(sock.localAddress) ? '0.0.0.0' : sock.localAddress;
        // Un service qui écoute mérite d'être visible.
        if (svc.category === 'system') {
          svc.category = 'network';
          svc.hiddenByDefault = false;
        }
      }
      continue;
    }
    // Port sans propriétaire connu : service autonome.
    const name = sock.processName ?? (sock.pid ? processName(sock.pid) : null) ?? `port-${sock.localPort}`;
    const id = stableId('svc', 'port', sock.localPort, name);
    if (services.some((s) => s.id === id)) continue;
    const { type } = classify(name, false);
    services.push({
      id,
      name,
      displayName: `${name} (port ${sock.localPort})`,
      type: type === 'system' ? 'other' : type,
      status: 'running',
      port: sock.localPort,
      address: isUnspecified(sock.localAddress) ? '0.0.0.0' : sock.localAddress,
      process: sock.processName ?? undefined,
      origin: 'detected',
      lastCheck: now,
      source: 'port',
      category: 'network',
      hiddenByDefault: false,
      pid: sock.pid,
      systemdUnit: null,
      dockerContainer: null,
      dockerImage: null,
      ports: [sock.localPort],
      startedAt: sock.pid ? processStartMs(sock.pid) : null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryMb: sock.pid ? processMemoryMb(sock.pid) : null,
      metadata: { protocol: sock.protocol },
    });
    portOwners.set(sock.localPort, id);
    if (sock.pid) pidOwners.set(sock.pid, id);
  }

  if (!hasTool('systemctl')) warnings.push('systemctl absent : détection des services système indisponible.');
  if (!dockerAvailable && hasTool('docker')) warnings.push('Docker installé mais non interrogeable (démon arrêté ou permissions).');

  // Uptime calculé de façon homogène.
  for (const s of services) {
    if (s.uptimeSeconds === null && s.startedAt) s.uptimeSeconds = Math.round((now - s.startedAt) / 1000);
  }

  return {
    services,
    portOwners,
    pidOwners,
    sources: { systemd: hasTool('systemctl'), docker: dockerAvailable, sockets: opts.sockets.hasOwnership },
    warnings,
  };
}
