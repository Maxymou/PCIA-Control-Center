/** Détection des connexions entre services.
 *
 *  Chaque connexion porte **la méthode de détection et un niveau de confiance**.
 *  Rien n'est présenté comme certain : une déduction (variable d'environnement,
 *  co-appartenance à un réseau Docker) reste marquée LOW/MEDIUM.
 *
 *  Priorité des corrections : une correction manuelle l'emporte toujours sur une
 *  détection ultérieure. Si une nouvelle observation la contredit, la correction
 *  est conservée et un **conflit** est enregistré pour arbitrage par l'utilisateur.
 */

import type { ConnectionStatus, ConnectionType } from '../contract.js';
import { hasTool, run } from '../system/exec.js';
import {
  CONFIDENCE_VALUES, type ConfidenceLevel, type DetectedConnection, type DetectedService,
  type DetectionMethod, stableId,
} from './model.js';
import { isLoopback, isUnspecified, type SocketSnapshot } from './ports.js';

/** Ports dont le protocole applicatif est connu — améliore le typage des liens. */
const KNOWN_PORT_TYPES: { ports: number[]; type: ConnectionType; protocol?: string }[] = [
  { ports: [5432], type: 'database', protocol: 'PostgreSQL' },
  { ports: [3306], type: 'database', protocol: 'MySQL' },
  { ports: [27017], type: 'database', protocol: 'MongoDB' },
  { ports: [6379], type: 'database', protocol: 'Redis' },
  { ports: [6333, 6334], type: 'database', protocol: 'Qdrant' },
  { ports: [443, 8443], type: 'https', protocol: 'HTTPS' },
  { ports: [8000, 8080, 11434, 5000, 7860, 3000, 3001], type: 'http', protocol: 'HTTP' },
];

function typeForPort(port: number): { type: ConnectionType; protocol?: string } {
  for (const entry of KNOWN_PORT_TYPES) {
    if (entry.ports.includes(port)) return { type: entry.type, protocol: entry.protocol };
  }
  return { type: 'network' };
}

/** Les points de terminaison « API OpenAI » sont fréquents sur un PC IA. */
function refineOpenAiLike(endpoint: string | undefined, type: ConnectionType): ConnectionType {
  if (endpoint && /\/v1\/(chat\/)?completions|\/v1\/models|\/v1\/embeddings/.test(endpoint)) return 'openai-api';
  return type;
}

export interface ConnectionDiscoveryInput {
  services: DetectedService[];
  portOwners: Map<number, string>;
  pidOwners: Map<number, string>;
  sockets: SocketSnapshot;
}

export interface ConnectionDiscoveryResult {
  connections: DetectedConnection[];
  warnings: string[];
}

function makeConnection(params: {
  sourceId: string;
  targetId: string;
  type: ConnectionType;
  protocol?: string;
  port?: number;
  endpoint?: string;
  status: ConnectionStatus;
  method: DetectionMethod;
  level: ConfidenceLevel;
  direction: DetectedConnection['direction'];
  remoteAddress?: string | null;
  note?: string;
  metadata?: Record<string, string | number | boolean | null>;
  hiddenByDefault?: boolean;
}): DetectedConnection {
  const now = Date.now();
  return {
    // L'identifiant ignore le statut : il doit rester stable quand l'état change.
    id: stableId('cx', params.sourceId, params.targetId, params.type, params.port ?? '', params.method),
    sourceId: params.sourceId,
    targetId: params.targetId,
    type: params.type,
    protocol: params.protocol,
    port: params.port,
    endpoint: params.endpoint,
    status: params.status,
    origin: 'detected',
    confidence: CONFIDENCE_VALUES[params.level],
    note: params.note,
    lastActivity: now,
    direction: params.direction,
    detectionMethod: params.method,
    confidenceLevel: params.level,
    remoteAddress: params.remoteAddress ?? null,
    lastObserved: now,
    hiddenByDefault: params.hiddenByDefault ?? false,
    metadata: params.metadata ?? {},
  };
}

// =====================================================================
// Docker : runtime, réseaux, compose, variables d'environnement
// =====================================================================

interface DockerInspectResult {
  name: string;
  env: string[];
  networks: string[];
  composeProject: string | null;
  composeService: string | null;
  dependsOn: string[];
  command: string;
}

async function inspectContainers(names: string[]): Promise<DockerInspectResult[]> {
  if (names.length === 0 || !hasTool('docker')) return [];
  const res = await run('docker', ['inspect', ...names], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout) as Record<string, any>[];
    return parsed.map((c) => {
      const labels = (c.Config?.Labels ?? {}) as Record<string, string>;
      const dependsRaw = labels['com.docker.compose.depends_on'] ?? '';
      return {
        name: String(c.Name ?? '').replace(/^\//, ''),
        env: (c.Config?.Env ?? []) as string[],
        networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
        composeProject: labels['com.docker.compose.project'] ?? null,
        composeService: labels['com.docker.compose.service'] ?? null,
        dependsOn: dependsRaw ? dependsRaw.split(',').map((s) => s.split(':')[0]).filter(Boolean) : [],
        command: Array.isArray(c.Config?.Cmd) ? (c.Config.Cmd as string[]).join(' ') : '',
      };
    });
  } catch {
    return [];
  }
}

/** Extrait les URL d'une variable d'environnement ou d'une ligne de commande. */
function extractEndpoints(text: string): { host: string; port: number; path: string; scheme: string }[] {
  const out: { host: string; port: number; path: string; scheme: string }[] = [];
  for (const m of text.matchAll(/(https?):\/\/([A-Za-z0-9._-]+):(\d{2,5})(\/[^\s"',;]*)?/g)) {
    out.push({ scheme: m[1], host: m[2], port: Number(m[3]), path: m[4] ?? '' });
  }
  return out;
}

// =====================================================================
// Détection
// =====================================================================

export async function discoverConnections(input: ConnectionDiscoveryInput): Promise<ConnectionDiscoveryResult> {
  const { services, portOwners, pidOwners, sockets } = input;
  const warnings: string[] = [];
  const byId = new Map(services.map((s) => [s.id, s]));
  const connections = new Map<string, DetectedConnection>();

  const add = (c: DetectedConnection) => {
    const existing = connections.get(c.id);
    // À identifiant égal, on garde la détection la plus fiable.
    if (!existing || (c.confidence ?? 0) > (existing.confidence ?? 0)) connections.set(c.id, c);
  };

  // --- 1. Sockets TCP établis : la preuve la plus directe ---
  const dockerEngine = services.find((s) => s.source === 'docker' && s.name === 'docker');
  let unresolvedSockets = 0;

  for (const sock of sockets.established) {
    if (!isLoopback(sock.remoteAddress) && !isLoopback(sock.localAddress)) {
      // Connexion sortante vers l'extérieur : hors périmètre du graphe interne.
      continue;
    }
    const sourceId = sock.pid !== null ? pidOwners.get(sock.pid) : undefined;
    const targetId = portOwners.get(sock.remotePort);
    if (!sourceId || !targetId || sourceId === targetId) {
      if (!sourceId || !targetId) unresolvedSockets++;
      continue;
    }
    const { type, protocol } = typeForPort(sock.remotePort);
    add(makeConnection({
      sourceId,
      targetId,
      type,
      protocol,
      port: sock.remotePort,
      status: 'active',
      method: sock.protocol === 'tcp' ? 'tcp-socket' : 'udp-socket',
      // Un socket établi observé est une preuve directe.
      level: 'HIGH',
      direction: 'outbound',
      remoteAddress: sock.remoteAddress,
      metadata: { localPort: sock.localPort, observedAt: Date.now() },
    }));
  }
  if (unresolvedSockets > 0 && !sockets.hasOwnership) {
    warnings.push(
      `${unresolvedSockets} connexions actives n’ont pas pu être rattachées à un service ` +
      '(propriétaires de sockets illisibles sans privilège).',
    );
  }

  // --- 2. Docker : appartenance runtime ---
  const containerServices = services.filter((s) => s.dockerContainer);
  if (dockerEngine) {
    for (const svc of containerServices) {
      add(makeConnection({
        sourceId: dockerEngine.id,
        targetId: svc.id,
        type: 'docker',
        status: svc.status === 'running' ? 'active' : 'unknown',
        method: 'docker-runtime',
        // Le conteneur est géré par ce démon : fait certain.
        level: 'HIGH',
        direction: 'outbound',
        metadata: { image: svc.dockerImage },
      }));
    }
  }

  // --- 3. Docker : compose, dépendances déclarées, variables d'environnement ---
  const inspected = await inspectContainers(containerServices.map((s) => s.dockerContainer!));
  const byContainerName = new Map(containerServices.map((s) => [s.dockerContainer!, s]));
  const byComposeService = new Map<string, DetectedService>();
  for (const info of inspected) {
    const svc = byContainerName.get(info.name);
    if (svc && info.composeService) byComposeService.set(`${info.composeProject}/${info.composeService}`, svc);
  }

  for (const info of inspected) {
    const source = byContainerName.get(info.name);
    if (!source) continue;

    // 3a. Dépendances déclarées dans docker-compose.
    for (const dep of info.dependsOn) {
      const target = byComposeService.get(`${info.composeProject}/${dep}`);
      if (!target || target.id === source.id) continue;
      add(makeConnection({
        sourceId: source.id,
        targetId: target.id,
        type: 'custom',
        status: 'unknown',
        method: 'docker-compose',
        // Dépendance déclarée : réelle, mais elle ne prouve pas un trafic.
        level: 'MEDIUM',
        direction: 'outbound',
        note: 'Dépendance déclarée dans docker-compose (pas de trafic observé).',
        metadata: { project: info.composeProject, dependsOn: dep },
      }));
    }

    // 3b. URL présentes dans l'environnement ou la commande.
    for (const raw of [...info.env, info.command]) {
      for (const ep of extractEndpoints(raw)) {
        const targetId = portOwners.get(ep.port)
          ?? byComposeService.get(`${info.composeProject}/${ep.host}`)?.id
          ?? byContainerName.get(ep.host)?.id;
        if (!targetId || targetId === source.id) continue;
        const base = typeForPort(ep.port);
        add(makeConnection({
          sourceId: source.id,
          targetId,
          type: refineOpenAiLike(ep.path, ep.scheme === 'https' ? 'https' : base.type),
          protocol: ep.scheme.toUpperCase(),
          port: ep.port,
          endpoint: ep.path || undefined,
          status: 'unknown',
          method: 'environment',
          // Configuration déclarée : forte présomption, sans preuve de trafic.
          level: 'MEDIUM',
          direction: 'outbound',
          remoteAddress: ep.host,
          note: 'Déduite d’une URL de configuration — trafic non observé.',
          metadata: { host: ep.host },
        }));
      }
    }
  }

  // --- 4. Réseaux Docker partagés : indice faible, masqué par défaut ---
  const networkMembers = new Map<string, DetectedService[]>();
  for (const info of inspected) {
    const svc = byContainerName.get(info.name);
    if (!svc) continue;
    for (const net of info.networks) {
      if (net === 'bridge' || net === 'host' || net === 'none') continue;
      networkMembers.set(net, [...(networkMembers.get(net) ?? []), svc]);
    }
  }
  for (const [net, members] of networkMembers) {
    if (members.length < 2 || members.length > 8) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const already = [...connections.values()].some(
          (c) => (c.sourceId === a.id && c.targetId === b.id) || (c.sourceId === b.id && c.targetId === a.id),
        );
        if (already) continue;
        add(makeConnection({
          sourceId: a.id,
          targetId: b.id,
          type: 'network',
          status: 'unknown',
          method: 'docker-network',
          // Simple co-appartenance : ne prouve aucune communication.
          level: 'LOW',
          direction: 'bidirectional',
          note: `Même réseau Docker (${net}) — communication possible, non observée.`,
          hiddenByDefault: true,
          metadata: { network: net },
        }));
      }
    }
  }

  // --- 5. Ports en écoute sans trafic : marqués « en attente » ---
  for (const sock of sockets.listening) {
    const ownerId = portOwners.get(sock.localPort);
    if (!ownerId) continue;
    const svc = byId.get(ownerId);
    if (!svc) continue;
    if (isUnspecified(sock.localAddress)) {
      svc.address ??= '0.0.0.0';
    }
  }

  return { connections: [...connections.values()], warnings };
}

/** Compare deux connexions du point de vue « ce qui compte pour l'utilisateur ». */
export function connectionShapeChanged(
  a: { sourceId: string; targetId: string; type: string; port?: number; endpoint?: string },
  b: { sourceId: string; targetId: string; type: string; port?: number; endpoint?: string },
): boolean {
  return a.sourceId !== b.sourceId
    || a.targetId !== b.targetId
    || a.type !== b.type
    || (a.port ?? null) !== (b.port ?? null)
    || (a.endpoint ?? null) !== (b.endpoint ?? null);
}
