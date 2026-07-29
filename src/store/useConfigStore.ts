/** Configuration utilisateur persistée en localStorage (clé `pcia-config`).
 *  Contient tout ce qui doit survivre au rechargement : disposition du graphe,
 *  masquages, groupes, services/connexions manuels, corrections, notes,
 *  réglages de ventilation, profils personnalisés, préférences. */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Connection, FanConfig, FanCurve, FanId, FanProfile, Service, ServiceGroup,
} from '../types';
import { seedFanConfigs, seedGroups, seedProfiles } from '../mocks/seed';
import { dataService } from '../services/dataService';
import { uid } from '../utils/format';

export type SaveState = 'saved' | 'saving' | 'error';

interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

/** Portion de l'état couverte par annuler / rétablir. */
interface UndoableSlice {
  layout: GraphLayout;
  hiddenServices: string[];
  hiddenConnections: string[];
  groups: ServiceGroup[];
  manualServices: Service[];
  manualConnections: Connection[];
  serviceOverrides: Record<string, Partial<Service>>;
  connectionOverrides: Record<string, Partial<Connection>>;
}

interface ConfigState extends UndoableSlice {
  savedLayout: GraphLayout | null;      // disposition restaurable explicitement
  filters: { statuses: string[]; types: string[]; search: string };
  fanConfigs: FanConfig[];
  customProfiles: FanProfile[];
  activeProfileId: string;
  prefs: {
    pulseAnimations: boolean;
    fanChartMode: 'rpm' | 'pwm' | 'both';
  };
  saveState: SaveState;
  undoStack: UndoableSlice[];
  redoStack: UndoableSlice[];

  // Actions graphe
  setPositions(pos: Record<string, { x: number; y: number }>, undoable?: boolean): void;
  setViewport(v: { x: number; y: number; zoom: number }): void;
  saveLayoutSnapshot(): void;
  restoreLayout(): void;
  resetLayout(): void;
  hideService(id: string): void;
  unhideService(id: string): void;
  hideConnection(id: string): void;
  unhideConnection(id: string): void;

  addManualService(s: Omit<Service, 'id' | 'origin' | 'lastCheck'>): void;
  updateManualService(id: string, patch: Partial<Service>): void;
  removeManualService(id: string): void;
  overrideService(id: string, patch: Partial<Service>): void;

  addManualConnection(c: Omit<Connection, 'id' | 'origin'>): void;
  updateManualConnection(id: string, patch: Partial<Connection>): void;
  removeManualConnection(id: string): void;
  correctConnection(id: string, patch: Partial<Connection>, original: Connection): void;
  restoreDetected(id: string): void;

  addGroup(name: string, serviceIds: string[]): void;
  updateGroup(id: string, patch: Partial<ServiceGroup>): void;
  removeGroup(id: string): void;

  setFilters(f: Partial<ConfigState['filters']>): void;

  // Ventilation
  updateFan(id: FanId, patch: Partial<FanConfig>): void;
  setCurve(id: FanId, curve: FanCurve): void;
  applyProfile(profileId: string, fanId?: FanId): void;
  duplicateProfile(profileId: string): void;
  createCustomProfile(name: string): void;
  renameProfile(id: string, name: string): void;
  deleteProfile(id: string): void;
  restoreBuiltinProfiles(): void;

  setPrefs(p: Partial<ConfigState['prefs']>): void;
  markSaving(): void;
  triggerSaveError(): void;

  undo(): void;
  redo(): void;
  resetAll(): void;
}

const emptyLayout: GraphLayout = { positions: {} };

function pickUndoable(s: ConfigState): UndoableSlice {
  return structuredClone({
    layout: s.layout,
    hiddenServices: s.hiddenServices,
    hiddenConnections: s.hiddenConnections,
    groups: s.groups,
    manualServices: s.manualServices,
    manualConnections: s.manualConnections,
    serviceOverrides: s.serviceOverrides,
    connectionOverrides: s.connectionOverrides,
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaving(set: (p: Partial<ConfigState>) => void, get: () => ConfigState) {
  if (get().saveState === 'error') return;
  set({ saveState: 'saving' });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (useConfigStore.getState().saveState !== 'error') {
      useConfigStore.setState({ saveState: 'saved' });
    }
  }, 700);
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => {
      /** Enregistre l'état courant dans la pile d'annulation puis applique la mutation. */
      const mutate = (patch: Partial<ConfigState>, undoable = true) => {
        const prev = get();
        set({
          ...(undoable
            ? { undoStack: [...prev.undoStack.slice(-49), pickUndoable(prev)], redoStack: [] }
            : {}),
          ...patch,
        });
        flashSaving(set, get);
      };

      const syncFans = (fans: FanConfig[]) => dataService.pushFanConfigs(fans);

      return {
        layout: emptyLayout,
        savedLayout: null,
        hiddenServices: [],
        hiddenConnections: [],
        groups: structuredClone(seedGroups),
        manualServices: [],
        manualConnections: [],
        serviceOverrides: {},
        connectionOverrides: {},
        filters: { statuses: [], types: [], search: '' },
        fanConfigs: structuredClone(seedFanConfigs),
        customProfiles: [{ id: 'p-custom', name: 'Personnalisé', builtin: false, curves: structuredClone(seedProfiles[1].curves) }],
        activeProfileId: 'p-balanced',
        prefs: { pulseAnimations: true, fanChartMode: 'rpm' },
        saveState: 'saved',
        undoStack: [],
        redoStack: [],

        setPositions: (pos, undoable = false) =>
          mutate({ layout: { ...get().layout, positions: { ...get().layout.positions, ...pos } } }, undoable),
        setViewport: (v) => mutate({ layout: { ...get().layout, viewport: v } }, false),
        saveLayoutSnapshot: () => mutate({ savedLayout: structuredClone(get().layout) }, false),
        restoreLayout: () => {
          const saved = get().savedLayout;
          if (saved) mutate({ layout: structuredClone(saved) });
        },
        resetLayout: () => mutate({ layout: emptyLayout }),

        hideService: (id) => mutate({ hiddenServices: [...new Set([...get().hiddenServices, id])] }),
        unhideService: (id) => mutate({ hiddenServices: get().hiddenServices.filter((x) => x !== id) }),
        hideConnection: (id) => mutate({ hiddenConnections: [...new Set([...get().hiddenConnections, id])] }),
        unhideConnection: (id) => mutate({ hiddenConnections: get().hiddenConnections.filter((x) => x !== id) }),

        addManualService: (s) =>
          mutate({
            manualServices: [...get().manualServices, { ...s, id: uid('msvc'), origin: 'manual', lastCheck: Date.now() }],
          }),
        updateManualService: (id, patch) =>
          mutate({ manualServices: get().manualServices.map((s) => (s.id === id ? { ...s, ...patch } : s)) }),
        removeManualService: (id) =>
          mutate({
            manualServices: get().manualServices.filter((s) => s.id !== id),
            manualConnections: get().manualConnections.filter((c) => c.sourceId !== id && c.targetId !== id),
          }),
        overrideService: (id, patch) =>
          mutate({ serviceOverrides: { ...get().serviceOverrides, [id]: { ...get().serviceOverrides[id], ...patch } } }),

        addManualConnection: (c) =>
          mutate({ manualConnections: [...get().manualConnections, { ...c, id: uid('mcx'), origin: 'manual' }] }),
        updateManualConnection: (id, patch) =>
          mutate({ manualConnections: get().manualConnections.map((c) => (c.id === id ? { ...c, ...patch } : c)) }),
        removeManualConnection: (id) =>
          mutate({ manualConnections: get().manualConnections.filter((c) => c.id !== id) }),
        correctConnection: (id, patch, original) =>
          mutate({
            connectionOverrides: {
              ...get().connectionOverrides,
              [id]: {
                ...get().connectionOverrides[id],
                ...patch,
                origin: 'corrected',
                detectedOriginal: get().connectionOverrides[id]?.detectedOriginal ?? original.detectedOriginal ?? {
                  sourceId: original.sourceId, targetId: original.targetId,
                  type: original.type, port: original.port, endpoint: original.endpoint,
                },
              },
            },
          }),
        restoreDetected: (id) => {
          const rest = { ...get().connectionOverrides };
          delete rest[id];
          mutate({ connectionOverrides: rest });
        },

        addGroup: (name, serviceIds) =>
          mutate({ groups: [...get().groups, { id: uid('grp'), name, serviceIds }] }),
        updateGroup: (id, patch) =>
          mutate({ groups: get().groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }),
        removeGroup: (id) => mutate({ groups: get().groups.filter((g) => g.id !== id) }),

        setFilters: (f) => mutate({ filters: { ...get().filters, ...f } }, false),

        updateFan: (id, patch) => {
          const fans = get().fanConfigs.map((f) => (f.id === id ? { ...f, ...patch } : f));
          mutate({ fanConfigs: fans }, false);
          syncFans(fans);
        },
        setCurve: (id, curve) => {
          const st = get();
          const fans = st.fanConfigs.map((f) => (f.id === id ? { ...f, curve } : f));
          // Modifier une courbe d'un profil prédéfini bascule sur « Personnalisé »
          let activeProfileId = st.activeProfileId;
          let customProfiles = st.customProfiles;
          const active = [...seedProfiles, ...st.customProfiles].find((p) => p.id === activeProfileId);
          if (active?.builtin) {
            activeProfileId = 'p-custom';
          }
          customProfiles = customProfiles.map((p) =>
            p.id === activeProfileId
              ? { ...p, curves: { ...p.curves, [id]: structuredClone(curve) } }
              : p,
          );
          mutate({ fanConfigs: fans, activeProfileId, customProfiles }, false);
          syncFans(fans);
        },
        applyProfile: (profileId, fanId) => {
          const all = [...seedProfiles, ...get().customProfiles];
          const p = all.find((x) => x.id === profileId);
          if (!p) return;
          const fans = get().fanConfigs.map((f) =>
            !fanId || f.id === fanId ? { ...f, curve: structuredClone(p.curves[f.id]), mode: f.mode === 'auto' ? 'auto' as const : f.mode } : f,
          );
          mutate({ fanConfigs: fans, ...(fanId ? {} : { activeProfileId: profileId }) }, false);
          syncFans(fans);
        },
        duplicateProfile: (profileId) => {
          const all = [...seedProfiles, ...get().customProfiles];
          const p = all.find((x) => x.id === profileId);
          if (!p) return;
          mutate({
            customProfiles: [...get().customProfiles, { id: uid('prof'), name: `${p.name} (copie)`, builtin: false, curves: structuredClone(p.curves) }],
          }, false);
        },
        createCustomProfile: (name) => {
          const curves = Object.fromEntries(get().fanConfigs.map((f) => [f.id, structuredClone(f.curve)])) as FanProfile['curves'];
          const id = uid('prof');
          mutate({ customProfiles: [...get().customProfiles, { id, name, builtin: false, curves }], activeProfileId: id }, false);
        },
        renameProfile: (id, name) =>
          mutate({ customProfiles: get().customProfiles.map((p) => (p.id === id ? { ...p, name } : p)) }, false),
        deleteProfile: (id) => {
          if (id === 'p-custom') return;
          const st = get();
          mutate({
            customProfiles: st.customProfiles.filter((p) => p.id !== id),
            activeProfileId: st.activeProfileId === id ? 'p-balanced' : st.activeProfileId,
          }, false);
        },
        restoreBuiltinProfiles: () => {
          // Les profils prédéfinis ne sont jamais modifiés : on réapplique simplement le profil actif s'il est prédéfini.
          const st = get();
          const p = seedProfiles.find((x) => x.id === st.activeProfileId);
          if (p) {
            const fans = st.fanConfigs.map((f) => ({ ...f, curve: structuredClone(p.curves[f.id]) }));
            mutate({ fanConfigs: fans }, false);
            syncFans(fans);
          }
        },

        setPrefs: (p) => mutate({ prefs: { ...get().prefs, ...p } }, false),
        markSaving: () => flashSaving(set, get),
        triggerSaveError: () => set({ saveState: 'error' }),

        undo: () => {
          const st = get();
          const prev = st.undoStack[st.undoStack.length - 1];
          if (!prev) return;
          set({
            ...prev,
            undoStack: st.undoStack.slice(0, -1),
            redoStack: [...st.redoStack, pickUndoable(st)],
          });
          flashSaving(set, get);
        },
        redo: () => {
          const st = get();
          const next = st.redoStack[st.redoStack.length - 1];
          if (!next) return;
          set({
            ...next,
            redoStack: st.redoStack.slice(0, -1),
            undoStack: [...st.undoStack, pickUndoable(st)],
          });
          flashSaving(set, get);
        },

        resetAll: () => {
          localStorage.removeItem('pcia-config');
          window.location.reload();
        },
      };
    },
    {
      name: 'pcia-config',
      partialize: (s) => ({
        layout: s.layout, savedLayout: s.savedLayout,
        hiddenServices: s.hiddenServices, hiddenConnections: s.hiddenConnections,
        groups: s.groups, manualServices: s.manualServices, manualConnections: s.manualConnections,
        serviceOverrides: s.serviceOverrides, connectionOverrides: s.connectionOverrides,
        filters: s.filters, fanConfigs: s.fanConfigs, customProfiles: s.customProfiles,
        activeProfileId: s.activeProfileId, prefs: s.prefs,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) dataService.pushFanConfigs(state.fanConfigs);
      },
    },
  ),
);

/** Pousse la config ventilateurs initiale vers la simulation au boot. */
export function bootConfig() {
  dataService.pushFanConfigs(useConfigStore.getState().fanConfigs);
}
