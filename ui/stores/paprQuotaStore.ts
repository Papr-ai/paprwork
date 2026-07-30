import { create } from "zustand";

export type PaprQuotaKind =
  | "operations"
  | "memories"
  | "storage"
  | "rate_limit"
  | "unknown";

export interface PaprQuotaBannerState {
  kind: PaprQuotaKind;
  severity: "warning" | "exceeded";
  title: string;
  detail: string;
  suggestMeteredBilling: boolean;
  billingUrl: string;
  source?: string;
  reportedAt: string;
}

interface PaprQuotaStore {
  active: PaprQuotaBannerState | null;
  dismissedKey: string | null;
  setQuotaStatus: (status: PaprQuotaBannerState) => void;
  dismiss: (status: PaprQuotaBannerState) => void;
  clearIfDismissed: () => void;
}

function statusKey(status: PaprQuotaBannerState): string {
  return `${status.kind}:${status.severity}:${status.title}`;
}

export const usePaprQuotaStore = create<PaprQuotaStore>((set, get) => ({
  active: null,
  dismissedKey: null,
  setQuotaStatus: (status) => {
    const key = statusKey(status);
    if (get().dismissedKey === key) return;
    set({ active: status });
  },
  dismiss: (status) => {
    set({ active: null, dismissedKey: statusKey(status) });
  },
  clearIfDismissed: () => {
    const { active, dismissedKey } = get();
    if (active && dismissedKey === statusKey(active)) {
      set({ active: null });
    }
  },
}));

export function initPaprQuotaListener(): void {
  const handler = (event: Event) => {
    const ev = event as CustomEvent<{ type?: string; data?: PaprQuotaBannerState }>;
    const { type, data } = ev.detail ?? {};
    if (type !== "papr:quota-status" || !data?.title) return;
    usePaprQuotaStore.getState().setQuotaStatus(data);
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
