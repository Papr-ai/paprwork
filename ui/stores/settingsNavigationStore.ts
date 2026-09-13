import { create } from "zustand";
import type { SettingsTab } from "../types/settings";

interface SettingsNavigationState {
  token: number;
  pendingTab: SettingsTab | null;
  pendingPlanFocus: boolean;
  /** Active settings sub-tab while SettingsView is mounted. */
  currentTab: SettingsTab | null;
  navigate: (options: { tab?: SettingsTab; focusPlan?: boolean }) => void;
  acknowledgeTab: () => void;
  acknowledgePlanFocus: () => void;
  setCurrentTab: (tab: SettingsTab | null) => void;
}

export const useSettingsNavigationStore = create<SettingsNavigationState>(
  (set) => ({
    token: 0,
    pendingTab: null,
    pendingPlanFocus: false,
    currentTab: null,
    navigate: (options) =>
      set((state) => ({
        token: state.token + 1,
        pendingTab: options.tab ?? state.pendingTab,
        pendingPlanFocus: options.focusPlan ?? state.pendingPlanFocus,
      })),
    acknowledgeTab: () => set({ pendingTab: null }),
    acknowledgePlanFocus: () => set({ pendingPlanFocus: false }),
    setCurrentTab: (tab) => set({ currentTab: tab }),
  }),
);
