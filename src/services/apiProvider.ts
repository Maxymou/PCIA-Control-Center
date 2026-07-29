/** Source de données réelle : API REST + WebSocket du back-end PCIA.
 *
 *  Comportement attendu par l'interface :
 *   - le WebSocket pousse un `Snapshot` complet ; s'il tombe, on bascule sur un
 *     rafraîchissement REST périodique et `backendConnected` passe à faux ;
 *   - les actions sont envoyées au back-end puis l'état est resynchronisé — on
 *     n'invente jamais d'état local optimiste sur des données matérielles.
 */

import type { FanConfig, FanId, FanProfile, Snapshot } from '../types';
import { ApiError, api, LiveSocket, type LiveMessage } from './apiClient';
import { emptySnapshot, type DataService, type DemoActions, type InitialConfig, type LogEventInput } from './types';

/** Cadence de repli quand le WebSocket est indisponible. */
const FALLBACK_POLL_MS = 5000;

type Listener = (snapshot: Snapshot) => void;

export class ApiDataProvider implements DataService {
  readonly kind = 'api' as const;

  private snapshot: Snapshot = emptySnapshot();
  private listeners: Listener[] = [];
  private socket: LiveSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private error: string | null = null;
  /** Dernières configurations poussées, pour n'envoyer que les changements. */
  private lastPushed = new Map<FanId, FanConfig>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<FanId, FanConfig>();

  start(): void {
    if (this.started) return;
    this.started = true;

    void this.refresh();

    this.socket = new LiveSocket({
      onMessage: (message) => this.handleMessage(message),
      onOpen: () => {
        this.error = null;
        this.stopPolling();
      },
      onClose: () => {
        // Perte du flux : l'interface doit le voir immédiatement.
        this.error = 'Flux temps réel interrompu — reconnexion en cours.';
        this.snapshot = { ...this.snapshot, backendConnected: false };
        this.emit();
        this.startPolling();
      },
    });
    this.socket.connect();
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.stopPolling();
    this.started = false;
  }

  private handleMessage(message: LiveMessage): void {
    if (message.type === 'snapshot') {
      this.snapshot = message.payload as Snapshot;
      this.error = null;
      this.emit();
      return;
    }
    // Les messages ciblés servent de signal : le snapshot fait autorité.
    if (message.type === 'fan_controller.health') return;
    void this.refresh();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), FALLBACK_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Resynchronisation complète par REST. */
  private async refresh(): Promise<void> {
    try {
      this.snapshot = await api.get<Snapshot>('/api/snapshot');
      this.error = null;
    } catch (err) {
      this.error = err instanceof ApiError ? err.message : String(err);
      this.snapshot = { ...this.snapshot, backendConnected: false };
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    listener(this.snapshot);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  lastError(): string | null {
    return this.error;
  }

  // =====================================================================
  // Ventilation
  // =====================================================================

  /** Le store pousse la configuration complète : on n'envoie que les deltas,
   *  regroupés, pour ne pas saturer l'API pendant l'édition d'une courbe. */
  pushFanConfigs(configs: FanConfig[]): void {
    for (const config of configs) {
      const previous = this.lastPushed.get(config.id);
      if (previous && JSON.stringify(previous) === JSON.stringify(config)) continue;
      this.pending.set(config.id, config);
    }
    if (this.pending.size === 0) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.flushFanConfigs(), 250);
  }

  private async flushFanConfigs(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const config of batch) {
      const previous = this.lastPushed.get(config.id);
      try {
        if (!previous || JSON.stringify(previous.curve) !== JSON.stringify(config.curve)) {
          await api.put(`/api/fans/${config.id}/curve`, { curve: config.curve });
        }
        if (!previous || previous.mode !== config.mode || previous.manualPwm !== config.manualPwm) {
          await api.put(`/api/fans/${config.id}/mode`, { mode: config.mode, manualPwm: config.manualPwm });
        }
        const settingsChanged = !previous
          || previous.displayName !== config.displayName
          || previous.assignedHardware !== config.assignedHardware
          || previous.customHardwareLabel !== config.customHardwareLabel
          || previous.minPwm !== config.minPwm
          || previous.warnRpm !== config.warnRpm
          || JSON.stringify(previous.sensor) !== JSON.stringify(config.sensor);
        if (settingsChanged) {
          await api.put(`/api/fans/${config.id}/configuration`, {
            displayName: config.displayName,
            assignedHardware: config.assignedHardware,
            customHardwareLabel: config.customHardwareLabel ?? null,
            sensor: config.sensor,
            manualPwm: config.manualPwm,
            minPwm: config.minPwm,
            warnRpm: config.warnRpm,
          });
        }
        this.lastPushed.set(config.id, structuredClone(config));
      } catch (err) {
        // Le serveur a refusé (courbe invalide, moteur hors ligne…) : on garde
        // la trace de l'erreur et on resynchronise pour revenir à l'état réel.
        this.error = err instanceof ApiError ? err.message : String(err);
        this.lastPushed.delete(config.id);
      }
    }
    await this.refresh();
  }

  startFanTest(id: FanId, seconds: number): void {
    void this.action(() => api.post(`/api/fans/${id}/test`, { seconds }));
  }

  stopFanTest(id: FanId): void {
    void this.action(() => api.post(`/api/fans/${id}/stop-test`));
  }

  // =====================================================================
  // Alertes et conflits
  // =====================================================================

  ackAlert(id: string): void {
    void this.action(() => api.post(`/api/alerts/${id}/acknowledge`));
  }

  snoozeAlert(id: string, minutes: number): void {
    void this.action(() => api.post(`/api/alerts/${id}/snooze`, { minutes }));
  }

  unsnoozeAlert(id: string): void {
    void this.action(() => api.post(`/api/alerts/${id}/unsnooze`));
  }

  resolveConflict(connectionId: string, acceptDetection: boolean): void {
    void this.action(() => api.post(`/api/connections/${connectionId}/resolve-conflict`, { acceptDetection }));
  }

  // =====================================================================
  // Journalisation
  // =====================================================================

  logEvent(event: LogEventInput): void {
    void this.action(() => api.post('/api/events', event), { refresh: false });
  }

  addProfileMarker(label: string): void {
    void this.action(() => api.post('/api/history/markers', { label, kind: 'profile' }), { refresh: false });
  }

  // =====================================================================
  // Démonstration
  // =====================================================================

  private demoAction(scenario: string): void {
    void this.action(() => api.post(`/api/demo/${scenario}`));
  }

  demo: DemoActions = {
    heatUpV100: () => this.demoAction('heatUpV100'),
    blockFan: () => this.demoAction('blockFan'),
    stopService: () => this.demoAction('stopService'),
    loseConnection: () => this.demoAction('loseConnection'),
    detectNewService: () => this.demoAction('detectNewService'),
    conflictingDetection: () => this.demoAction('conflictingDetection'),
    toggleGtx: () => this.demoAction('toggleGtx'),
    newAlert: () => this.demoAction('newAlert'),
    backToNormal: () => this.demoAction('backToNormal'),
    toggleBackend: () => this.demoAction('toggleBackend'),
  };

  // =====================================================================
  // Configuration
  // =====================================================================

  async loadInitialConfig(): Promise<InitialConfig | null> {
    try {
      const [fans, profiles] = await Promise.all([
        api.get<{ configs: FanConfig[]; activeProfileId: string }>('/api/fans'),
        api.get<{ profiles: FanProfile[]; activeProfileId: string }>('/api/fan-profiles'),
      ]);
      for (const config of fans.configs) this.lastPushed.set(config.id, structuredClone(config));
      return {
        fanConfigs: fans.configs,
        builtinProfiles: profiles.profiles.filter((p) => p.builtin),
        customProfiles: profiles.profiles.filter((p) => !p.builtin),
        activeProfileId: profiles.activeProfileId ?? fans.activeProfileId,
      };
    } catch (err) {
      this.error = err instanceof ApiError ? err.message : String(err);
      return null;
    }
  }

  async loadUiState(): Promise<Record<string, unknown> | null> {
    try {
      const res = await api.get<{ data: Record<string, unknown> | null }>('/api/config/ui');
      return res.data;
    } catch {
      return null;
    }
  }

  async saveUiState(state: Record<string, unknown>): Promise<void> {
    await api.put('/api/config/ui', { data: state });
  }

  // =====================================================================
  // Utilitaires
  // =====================================================================

  private async action(fn: () => Promise<unknown>, opts: { refresh?: boolean } = {}): Promise<void> {
    try {
      await fn();
      this.error = null;
    } catch (err) {
      this.error = err instanceof ApiError ? err.message : String(err);
    }
    if (opts.refresh !== false) await this.refresh();
    else this.emit();
  }
}
