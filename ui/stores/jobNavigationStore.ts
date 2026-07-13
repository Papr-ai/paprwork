import { create } from "zustand";
import { useTabStore } from "./tabStore";

interface JobNavigationState {
  focusJobId: string | null;
  selectedJobId: string | null;
  selectedJobName: string | null;
  requestFocusJob: (jobId: string) => void;
  clearFocusJob: () => void;
  setSelectedJob: (jobId: string, name: string) => void;
  clearSelectedJob: () => void;
}

export const useJobNavigationStore = create<JobNavigationState>((set) => ({
  focusJobId: null,
  selectedJobId: null,
  selectedJobName: null,
  requestFocusJob: (jobId: string) => set({ focusJobId: jobId }),
  clearFocusJob: () => set({ focusJobId: null }),
  setSelectedJob: (jobId: string, name: string) =>
    set({ selectedJobId: jobId, selectedJobName: name }),
  clearSelectedJob: () => set({ selectedJobId: null, selectedJobName: null }),
}));

export function openJobInJobsTab(jobId: string): void {
  useJobNavigationStore.getState().requestFocusJob(jobId);
  const { createTab, switchToTab } = useTabStore.getState();
  const tabId = createTab("jobs", "jobs", "Jobs");
  switchToTab(tabId);
}
