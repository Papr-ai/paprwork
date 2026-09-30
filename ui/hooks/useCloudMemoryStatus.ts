import { useCallback, useEffect } from "react";
import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import { useCloudMemoryStatusStore } from "../stores/cloudMemoryStatusStore";
import {
  usePaprQuotaStore,
  type PaprQuotaKind,
} from "../stores/paprQuotaStore";
import {
  deriveCloudMemoryStatus,
  type CloudMemoryStatus,
} from "../utils/cloudMemoryStatus";
import { refreshPaprBillingStatus, resetBillingUiForWorkspaceSwitch } from "../utils/refreshPaprBillingStatus";

function statusFromSummary(
  summary: PaprPlanSummary,
  quotaKind: PaprQuotaKind | null,
): CloudMemoryStatus | null {
  return deriveCloudMemoryStatus(
    summary,
    quotaKind === "subscription" ? "subscription" : null,
  );
}

export function useCloudMemoryStatus(): CloudMemoryStatus | null {
  const status = useCloudMemoryStatusStore((state) => state.status);
  const setBillingState = useCloudMemoryStatusStore((state) => state.setBillingState);
  const quotaActive = usePaprQuotaStore((state) => state.active);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      try {
        const login = await window.electronAPI.papr.checkLoginStatus();
        if (!login.success || !login.isLoggedIn) {
          setBillingState(null);
          return;
        }

        const summary = await refreshPaprBillingStatus({
          force: options?.force,
        });
        if (!summary) {
          setBillingState(null);
          return;
        }

        setBillingState(
          statusFromSummary(summary, quotaActive?.kind ?? null),
          summary,
        );
      } catch {
        setBillingState(null);
      }
    },
    [quotaActive?.kind, setBillingState],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const events = [
      "papr-auth-success",
      "papr-logout-success",
      "papr-organization-changed",
      "papr-namespace-changed",
      "papr:focus-plan-section",
    ] as const;

    const handler = () => {
      void refresh({ force: true });
    };
    const onWorkspaceSwitchStarting = () => {
      resetBillingUiForWorkspaceSwitch();
    };

    window.addEventListener("papr-workspace-switch-starting", onWorkspaceSwitchStarting);

    for (const eventName of events) {
      window.addEventListener(eventName, handler);
    }

    return () => {
      window.removeEventListener("papr-workspace-switch-starting", onWorkspaceSwitchStarting);
      for (const eventName of events) {
        window.removeEventListener(eventName, handler);
      }
    };
  }, [refresh]);

  return status;
}
