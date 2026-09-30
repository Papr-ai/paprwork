import { create } from "zustand";
import { gateway } from "../src/lib/gateway";
import type { JobRunDashboard } from "../hooks/useJobRunDashboard";

const EMPTY_DASHBOARD: JobRunDashboard = {
  totalJobs: 0,
  activeJobs: 0,
  totalRuns: 0,
  completedRuns: 0,
  failedRuns: 0,
  cancelledRuns: 0,
  successRate: 0,
  topJobs: [],
  recentRuns: [],
};

interface JobRunDashboardState {
  dashboard: JobRunDashboard | null;
  loading: boolean;
  error: string | null;
  hasLoaded: boolean;
  loadDashboard: (options?: { silent?: boolean }) => Promise<void>;
  ensureLoaded: () => Promise<void>;
}

export const useJobRunDashboardStore = create<JobRunDashboardState>(
  (set, get) => ({
    dashboard: null,
    loading: false,
    error: null,
    hasLoaded: false,

    loadDashboard: async (options) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        set({ loading: true, error: null });
      }
      try {
        const response = await gateway.send("jobs:run-dashboard", {
          recentLimit: 5,
        });
        if (response.success && response.data) {
          set({
            dashboard: response.data as JobRunDashboard,
            hasLoaded: true,
            error: null,
          });
        } else {
          set({ dashboard: EMPTY_DASHBOARD, hasLoaded: true });
        }
      } catch (err) {
        if (!silent) {
          set({
            error:
              err instanceof Error
                ? err.message
                : "Failed to load job run stats",
            dashboard: EMPTY_DASHBOARD,
          });
        }
      } finally {
        if (!silent) {
          set({ loading: false });
        }
      }
    },

    ensureLoaded: async () => {
      const { hasLoaded, dashboard, loadDashboard } = get();
      const silent = hasLoaded || dashboard !== null;
      await loadDashboard({ silent });
    },
  }),
);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollSubscribers = 0;

function handleGatewayBroadcast(
  event: CustomEvent<{ type: string; data?: Record<string, unknown> }>,
): void {
  const { type } = event.detail ?? {};
  if (type === "jobs:status-changed") {
    void useJobRunDashboardStore.getState().loadDashboard({ silent: true });
  }
}

function onDocumentVisible(): void {
  if (typeof document !== "undefined" && !document.hidden && pollSubscribers > 0) {
    void useJobRunDashboardStore.getState().loadDashboard({ silent: true });
  }
}

export function subscribeJobRunDashboardPolling(): () => void {
  pollSubscribers += 1;
  if (pollSubscribers === 1) {
    pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void useJobRunDashboardStore.getState().loadDashboard({ silent: true });
    }, 10_000);
    window.addEventListener(
      "gateway-broadcast",
      handleGatewayBroadcast as EventListener,
    );
    document.addEventListener("visibilitychange", onDocumentVisible);
  }

  return () => {
    pollSubscribers = Math.max(0, pollSubscribers - 1);
    if (pollSubscribers === 0) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      window.removeEventListener(
        "gateway-broadcast",
        handleGatewayBroadcast as EventListener,
      );
      document.removeEventListener("visibilitychange", onDocumentVisible);
    }
  };
}
