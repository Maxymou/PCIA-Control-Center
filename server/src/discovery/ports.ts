/** Sockets en écoute et connexions établies.
 *
 *  Source privilégiée : `/proc/net/{tcp,tcp6,udp,udp6}` + `/proc/<pid>/fd`,
 *  qui ne dépend d'aucun outil externe et fonctionne sans privilège pour les
 *  processus de l'utilisateur courant. `ss` est utilisé en complément quand il
 *  est disponible (il donne le propriétaire des sockets des autres utilisateurs
 *  si le service tourne avec les droits nécessaires).
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { hasTool, run } from '../system/exec.js';
import { createLogger } from '../logger.js';

const log = createLogger('discovery.ports');

export interface SocketEntry {
  protocol: 'tcp' | 'udp';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: 'LISTEN' | 'ESTABLISHED' | 'OTHER';
  inode: string;
  pid: number | null;
  processName: string | null;
}

const TCP_STATES: Record<string, SocketEntry['state']> = {
  '01': 'ESTABLISHED',
  '0A': 'LISTEN',
};

function hexToIpv4(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.');
}

function hexToIpv6(hex: string): string {
  // Format /proc : 4 mots little-endian de 32 bits.
  const words: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    const word = hex.slice(i, i + 8);
    const le = (word.slice(6, 8) + word.slice(4, 6) + word.slice(2, 4) + word.slice(0, 2)).toLowerCase();
    words.push(le.slice(0, 4), le.slice(4, 8));
  }
  const compact = words.join(':').replace(/(^|:)(0{1,4}:)+/, '::');
  // Les adresses IPv4-mappées sont plus lisibles en notation v4.
  const v4 = /^::ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(words.join(':').replace(/0{1,3}(?=[0-9a-f])/g, ''));
  if (v4) {
    const a = Number.parseInt(v4[1], 16);
    const b = Number.parseInt(v4[2], 16);
    return [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff].join('.');
  }
  return compact;
}

function parseProcNet(path: string, protocol: 'tcp' | 'udp', ipv6: boolean): SocketEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: SocketEntry[] = [];
  const lines = raw.split('\n').slice(1);
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [localHex, localPortHex] = f[1].split(':');
    const [remoteHex, remotePortHex] = f[2].split(':');
    if (!localPortHex || !remotePortHex) continue;
    const state = protocol === 'tcp'
      ? TCP_STATES[f[3]] ?? 'OTHER'
      : (Number.parseInt(remotePortHex, 16) === 0 ? 'LISTEN' : 'ESTABLISHED');
    out.push({
      protocol,
      localAddress: ipv6 ? hexToIpv6(localHex) : hexToIpv4(localHex),
      localPort: Number.parseInt(localPortHex, 16),
      remoteAddress: ipv6 ? hexToIpv6(remoteHex) : hexToIpv4(remoteHex),
      remotePort: Number.parseInt(remotePortHex, 16),
      state,
      inode: f[9],
      pid: null,
      processName: null,
    });
  }
  return out;
}

/** Table inode de socket → PID, construite à partir de /proc/<pid>/fd. */
function socketOwners(): Map<string, { pid: number; name: string }> {
  const map = new Map<string, { pid: number; name: string }>();
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return map;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // processus d'un autre utilisateur : normal sans privilège
    }
    let name = '';
    try {
      name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
      /* ignoré */
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m) map.set(m[1], { pid: Number(pid), name });
      } catch {
        /* fd disparu entre-temps */
      }
    }
  }
  return map;
}

/** Complète les sockets non attribués avec `ss`, quand il est disponible. */
async function enrichWithSs(entries: SocketEntry[]): Promise<void> {
  if (!hasTool('ss')) return;
  const res = await run('ss', ['-tunapH'], { timeoutMs: 5000 });
  if (!res.ok) return;
  const byKey = new Map<string, SocketEntry>();
  for (const e of entries) byKey.set(`${e.protocol}:${e.localPort}:${e.remoteAddress}:${e.remotePort}`, e);

  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] === 'tcp' ? 'tcp' : cols[0] === 'udp' ? 'udp' : null;
    if (!proto) continue;
    const localPort = Number(cols[4].split(':').pop());
    const remote = cols[5] ?? '';
    const remotePort = Number(remote.split(':').pop());
    const remoteAddress = remote.slice(0, remote.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (!users) continue;
    const entry = byKey.get(`${proto}:${localPort}:${remoteAddress}:${remotePort}`);
    if (entry && entry.pid === null) {
      entry.processName = users[1];
      entry.pid = Number(users[2]);
    }
  }
}

export interface SocketSnapshot {
  listening: SocketEntry[];
  established: SocketEntry[];
  /** Vrai si l'attribution processus a fonctionné pour au moins un socket. */
  hasOwnership: boolean;
}

export async function readSockets(): Promise<SocketSnapshot> {
  const entries = [
    ...parseProcNet('/proc/net/tcp', 'tcp', false),
    ...parseProcNet('/proc/net/tcp6', 'tcp', true),
    ...parseProcNet('/proc/net/udp', 'udp', false),
    ...parseProcNet('/proc/net/udp6', 'udp', true),
  ];
  const owners = socketOwners();
  for (const e of entries) {
    const owner = owners.get(e.inode);
    if (owner) {
      e.pid = owner.pid;
      e.processName = owner.name;
    }
  }
  await enrichWithSs(entries);

  const hasOwnership = entries.some((e) => e.pid !== null);
  if (!hasOwnership && entries.length > 0) {
    log.throttled('no-ownership', 600_000, 'info',
      'Propriétaires de sockets indisponibles : la corrélation des connexions sera dégradée.');
  }

  return {
    listening: entries.filter((e) => e.state === 'LISTEN'),
    established: entries.filter((e) => e.state === 'ESTABLISHED'),
    hasOwnership,
  };
}

/** Vrai pour les adresses locales à la machine. */
export function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.');
}

export function isUnspecified(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '';
}
