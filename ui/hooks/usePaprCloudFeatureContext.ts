import { useCallback, useEffect } from "react";
import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import { buildPaprCloudAccessContext } from "../../src/core/utils/paprCloudFeatureAccess";
import { deriveCloudMemoryStatus } from "../utils/cloudMemoryStatus";
import { refreshPaprBillingStatus } from "../utils/refreshPaprBillingStatus";
import { gateway } from "../src/lib/gateway";
import { usePaprCloudFeatureStore } from "../stores/paprCloudFeatureStore";
import { useCloudMemoryStatusStore } from "../stores/cloudMemoryStatusStore";

async function loadCloudSyncEnabled(): Promise<boolean> {
  try {
    const response = await gateway.send("settings:get");
    const prefs = response.data as { preferences?: { cloudSyncEnabled?: boolean } };
    return prefs.preferences?.cloudSyncEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Keeps Papr Cloud feature access context in sync for lock modals.
 */
export function usePaprCloudFeatureContext(): void {
  const setContext = usePaprCloudFeatureStore((state) => state.setContext);

  const refresh = useCallback(async () => {
    try {
      const login = await window.electronAPI.papr.checkLoginStatus();
      const isLoggedIn = Boolean(login.success && login.isLoggedIn);
      const cloudSyncEnabled = await loadCloudSyncEnabled();

      if (!isLoggedIn) {
        setContext(
          buildPaprCloudAccessContext({
            isLoggedIn: false,
            subscriptionStatus: null,
            cloudSyncEnabled,
          }),
        );
        return;
      }

      const plan = await refreshPaprBillingStatus();
      const subscriptionStatus = plan?.subscriptionStatus ?? null;
      // Read at call time, never subscribed. This is the fallback for a failed
      // plan fetch, so it is needed when the callback runs — not to decide
      // whether it should run. Subscribing put it in the dependency list below,
      // and since `refreshPaprBillingStatus` writes this very value, calling
      // `refresh` gave `refresh` a new identity, which re-ran the effect that
      // called it. That loop ran ~9 times a second for a whole session.
      const cloudStatus = useCloudMemoryStatusStore.getState().status;
      const memoryPaused =
        plan !== null ? deriveCloudMemoryStatus(plan) !== null : cloudStatus !== null;

      setContext(
        buildPaprCloudAccessContext({
          isLoggedIn: true,
          subscriptionStatus,
          cloudSyncEnabled,
          memoryPaused,
        }),
      );
    } catch {
      setContext(null);
    }
    // `setContext` is a zustand action, so this callback is stable for the
    // lifetime of the hook. Nothing that `refresh` writes may appear here.
  }, [setContext]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshEvents = [
      "papr-auth-success",
      "papr-logout-success",
      "papr-organization-changed",
      "papr-namespace-changed",
      "papr:focus-plan-section",
    ] as const;

    const handler = () => {
      void refreshPaprBillingStatus({ force: true });
    };

    const billingHandler = (event: Event) => {
      void (async () => {
        const detail = (event as CustomEvent<{ summary?: PaprPlanSummary }>).detail;
        if (!detail?.summary) {
          void refresh();
          return;
        }

        const login = await window.electronAPI.papr.checkLoginStatus();
        const isLoggedIn = Boolean(login.success && login.isLoggedIn);
        const cloudSyncEnabled = await loadCloudSyncEnabled();
        const memoryPaused = deriveCloudMemoryStatus(detail.summary) !== null;

        setContext(
          buildPaprCloudAccessContext({
            isLoggedIn,
            subscriptionStatus: detail.summary.subscriptionStatus,
            cloudSyncEnabled,
            memoryPaused,
          }),
        );
      })();
    };

    const focusHandler = () => {
      void refreshPaprBillingStatus({ force: true });
    };

    // Named, so the cleanup below can actually remove it. As an inline arrow it
    // was unremovable even in principle, and with the effect re-running on a
    // loop it accumulated ~19,000 listeners in one session — every one of which
    // fired a billing refresh the moment the window was shown again.
    const visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        focusHandler();
      }
    };

    for (const eventName of refreshEvents) {
      window.addEventListener(eventName, handler);
    }
    window.addEventListener("papr:billing-refreshed", billingHandler);
    window.addEventListener("focus", focusHandler);
    document.addEventListener("visibilitychange", visibilityHandler);

    return () => {
      for (const eventName of refreshEvents) {
        window.removeEventListener(eventName, handler);
      }
      window.removeEventListener("papr:billing-refreshed", billingHandler);
      window.removeEventListener("focus", focusHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [refresh, setContext]);
}
