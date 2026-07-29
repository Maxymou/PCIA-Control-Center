/** Informations système : noyau, distribution, carte mère, BIOS.
 *
 *  Utilisées pour le diagnostic et pour invalider une calibration lorsque le
 *  BIOS ou le noyau a changé (le comportement du contrôleur peut différer).
 */

import { readFileSync } from 'node:fs';
import { hostname, release } from 'node:os';
import { readDmi } from '../hwmon/sysfs.js';

export interface SystemInfo {
  hostname: string;
  kernel: string;
  distribution: string;
  biosVersion: string | null;
  boardVendor: string | null;
  boardName: string | null;
}

function readOsRelease(): string {
  try {
    const raw = readFileSync('/etc/os-release', 'utf8');
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(raw)?.[1];
    if (pretty) return pretty;
    const name = /^NAME="?([^"\n]+)"?$/m.exec(raw)?.[1];
    const version = /^VERSION="?([^"\n]+)"?$/m.exec(raw)?.[1];
    if (name) return version ? `${name} ${version}` : name;
  } catch {
    /* non-Linux ou fichier absent */
  }
  return `${process.platform} ${release()}`;
}

let cache: SystemInfo | null = null;

export function readSystemInfo(refresh = false): SystemInfo {
  if (cache && !refresh) return cache;
  const dmi = readDmi();
  cache = {
    hostname: hostname(),
    kernel: release(),
    distribution: readOsRelease(),
    biosVersion: dmi.biosVersion,
    boardVendor: dmi.boardVendor,
    boardName: dmi.boardName,
  };
  return cache;
}

/** Nom lisible de la carte mère, ou null si le DMI n'est pas exposé. */
export function boardLabel(info: SystemInfo): string | null {
  if (!info.boardName && !info.boardVendor) return null;
  return [info.boardVendor, info.boardName].filter(Boolean).join(' ');
}
