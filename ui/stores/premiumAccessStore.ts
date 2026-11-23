/**
 * Whether premium models on Papr credits are locked for this account (free plan
 * or pay as you go off). Filled by useAuthStatus from the gateway's
 * `papr:entitlements` (memory server GET /v1/ai/entitlements). Defaults to
 * unlocked so nothing is greyed out before the answer arrives or when offline.
 */
import { create } from "zustand";
import { gateway } from "../src/lib/gateway";

interface PremiumAccessState {
  locked: boolean;
  reason: string | null;
  refresh: () => Promise<void>;
  reset: () => void;
}

export const usePremiumAccessStore = create<PremiumAccessState>((set) => ({
  locked: false,
  reason: null,
  refresh: async () => {
    try {
      const res = await gateway.send("papr:entitlements", undefined, { timeoutMs: 8_000 });
      const data = res.data as { premium?: boolean; reason?: string | null } | undefined;
      set({ locked: res.success && data?.premium === false, reason: data?.reason ?? null });
    } catch {
      set({ locked: false, reason: null });
    }
  },
  reset: () => set({ locked: false, reason: null }),
}));
