/** Modèle enrichi des services et connexions détectés.
 *
 *  Le front-end consomme `Service` / `Connection` (src/types) ; les champs
 *  supplémentaires ci-dessous sont additifs et ignorés par les composants
 *  existants, mais exposés par l'API pour les vues futures et le diagnostic.
 */

import { createHash } from 'node:crypto';
import type { Connection, Service } from '../contract.js';

/** Provenance de l'information. */
export type DiscoverySource = 'systemd' | 'docker' | 'process' | 'port' | 'manual' | 'declared';

/** Classification : évite de noyer la vue principale sous les unités système. */
export type ServiceCategory =
  | 'important' | 'application' | 'container' | 'ai' | 'network' | 'system' | 'manual';

export interface DetectedService extends Service {
  source: DiscoverySource;
  category: ServiceCategory;
  /** Masqué par défaut dans la vue principale (services système). */
  hiddenByDefault: boolean;
  pid: number | null;
  systemdUnit: string | null;
  dockerContainer: string | null;
  dockerImage: string | null;
  ports: number[];
  startedAt: number | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  metadata: Record<string, string | number | boolean | null>;
}

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type DetectionMethod =
  | 'tcp-socket' | 'udp-socket' | 'listening-port' | 'docker-runtime'
  | 'docker-network' | 'docker-compose' | 'environment' | 'command-line'
  | 'config-file' | 'known-endpoint' | 'declared-dependency' | 'manual';

export interface DetectedConnection extends Connection {
  /** Sens de la relation, tel qu'observé. */
  direction: 'outbound' | 'inbound' | 'bidirectional';
  detectionMethod: DetectionMethod;
  confidenceLevel: ConfidenceLevel;
  /** Adresse observée côté distant. */
  remoteAddress: string | null;
  lastObserved: number;
  hiddenByDefault: boolean;
  metadata: Record<string, string | number | boolean | null>;
}

/** Confiance numérique attendue par le front-end (`confidence?: number`). */
export const CONFIDENCE_VALUES: Record<ConfidenceLevel, number> = {
  LOW: 0.35,
  MEDIUM: 0.65,
  HIGH: 0.95,
};

export function confidenceLevelFor(value: number): ConfidenceLevel {
  if (value >= 0.8) return 'HIGH';
  if (value >= 0.5) return 'MEDIUM';
  return 'LOW';
}

/** Identifiant déterministe : il doit survivre aux redémarrages pour que
 *  notes, corrections et masquages restent attachés au bon élément. */
export function stableId(prefix: string, ...parts: (string | number | null | undefined)[]): string {
  const material = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|');
  return `${prefix}-${createHash('sha1').update(material).digest('hex').slice(0, 10)}`;
}

/** Catégories affichées par défaut dans la vue principale. */
export const DEFAULT_VISIBLE_CATEGORIES: ServiceCategory[] = [
  'important', 'application', 'container', 'ai', 'network', 'manual',
];
