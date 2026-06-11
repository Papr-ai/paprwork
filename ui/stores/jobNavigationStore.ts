import { create } from "zustand";
import { useTabStore } from "./tabStore";

interface JobNavigationState {
  focusJobId: string | null;
  requestFocusJob: (jobId: string) => void;
  clearFocusJob: () => void;
}

export const useJobNavigationStore = create<JobNavigationState>((set) => ({
  focusJobId: null,
  requestFocusJob: (jobId: string) => set({ focusJobId: jobId }),
  clearFocusJob: () => set({ focusJobId: null }),
}));

export function openJobInJobsTab(jobId: string): void {
  useJobNavigationStore.getState().requestFocusJob(jobId);
  const { createTab, switchToTab } = useTabStore.getState();
  const tabId = createTab("jobs", "jobs", "Jobs");
  switchToTab(tabId);
}
