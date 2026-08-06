import { create } from 'zustand';
import type { FanId, HardwareId } from '../types';
import type { SectionId } from '../ui/sections';

/** Identifiant de section affichée. Remplace l'ancien `TabId` à deux valeurs ;
 *  cet état n'étant pas persisté, aucune migration n'est nécessaire. */
export type TabId = SectionId;

interface UiState {
  tab: TabId;
  alertsOpen: boolean;
  selectedServiceId: string | null;
  selectedConnectionId: string | null;
  selectedGroupId: string | null;
  selectedFanId: FanId | null;
  selectedHardwareId: HardwareId | null;
  /** Détail de l'élément sélectionné ouvert en feuille (présentation mobile). */
  detailSheetOpen: boolean;
  setTab(t: TabId): void;
  setAlertsOpen(v: boolean): void;
  setDetailSheetOpen(v: boolean): void;
  selectService(id: string | null): void;
  selectConnection(id: string | null): void;
  selectGroup(id: string | null): void;
  selectFan(id: FanId | null): void;
  selectHardware(id: HardwareId | null): void;
  clearSelection(): void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: 'overview',
  alertsOpen: false,
  selectedServiceId: null,
  selectedConnectionId: null,
  selectedGroupId: null,
  selectedFanId: 'CPU_FAN1',
  selectedHardwareId: null,
  detailSheetOpen: false,
  setTab: (tab) => set({ tab }),
  setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
  setDetailSheetOpen: (detailSheetOpen) => set({ detailSheetOpen }),
  // Sélectionner un élément demande l'ouverture de son détail. Sur poste de
  // travail, le panneau latéral l'affiche déjà en permanence et l'indicateur est
  // simplement ignoré ; sur mobile, il déclenche la feuille.
  selectService: (id) => set({
    selectedServiceId: id, selectedConnectionId: null, selectedGroupId: null,
    detailSheetOpen: id !== null,
  }),
  selectConnection: (id) => set({
    selectedConnectionId: id, selectedServiceId: null, selectedGroupId: null,
    detailSheetOpen: id !== null,
  }),
  selectGroup: (id) => set({
    selectedGroupId: id, selectedServiceId: null, selectedConnectionId: null,
    detailSheetOpen: id !== null,
  }),
  selectFan: (id) => set({ selectedFanId: id }),
  selectHardware: (id) => set({ selectedHardwareId: id }),
  clearSelection: () => set({
    selectedServiceId: null, selectedConnectionId: null, selectedGroupId: null,
    detailSheetOpen: false,
  }),
}));
