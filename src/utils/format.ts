let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
