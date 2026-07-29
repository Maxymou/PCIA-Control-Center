import { create } from 'zustand';
import type { Snapshot } from '../types';
import { dataService } from '../services/dataService';

interface LiveState {
  snap: Snapshot;
}

export const useLiveStore = create<LiveState>(() => ({
  snap: dataService.getSnapshot(),
}));

/** Démarre la simulation et alimente le store. À appeler une fois au boot. */
export function bootLiveData() {
  dataService.start();
  dataService.subscribe((snap) => useLiveStore.setState({ snap }));
}
