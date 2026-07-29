import { create } from 'zustand';
import type { FanId, HardwareId } from '../types';

export type TabId = 'programs' | 'hardware';

interface UiState {
  tab: TabId;
  alertsOpen: boolean;
  selectedServiceId: string | null;
  selectedConnectionId: string | null;
  selectedGroupId: string | null;
  selectedFanId: FanId | null;
  selectedHardwareId: HardwareId | null;
  setTab(t: TabId): void;
  setAlertsOpen(v: boolean): void;
  selectService(id: string | null): void;
  selectConnection(id: string | null): void;
  selectGroup(id: string | null): void;
  selectFan(id: FanId | null): void;
  selectHardware(id: HardwareId | null): void;
  clearSelection(): void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: 'programs',
  alertsOpen: false,
  selectedServiceId: null,
  selectedConnectionId: null,
  selectedGroupId: null,
  selectedFanId: 'CPU_FAN1',
  selectedHardwareId: null,
  setTab: (tab) => set({ tab }),
  setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
  selectService: (id) => set({ selectedServiceId: id, selectedConnectionId: null, selectedGroupId: null }),
  selectConnection: (id) => set({ selectedConnectionId: id, selectedServiceId: null, selectedGroupId: null }),
  selectGroup: (id) => set({ selectedGroupId: id, selectedServiceId: null, selectedConnectionId: null }),
  selectFan: (id) => set({ selectedFanId: id }),
  selectHardware: (id) => set({ selectedHardwareId: id }),
  clearSelection: () => set({ selectedServiceId: null, selectedConnectionId: null, selectedGroupId: null }),
}));
