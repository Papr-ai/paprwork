import { create } from "zustand";

export type CloudAppInstallPhase =
  | "prepare"
  | "source"
  | "resources"
  | "databases"
  | "finalize";

export const CLOUD_APP_INSTALL_PHASES: CloudAppInstallPhase[] = [
  "prepare",
  "source",
  "resources",
  "databases",
  "finalize",
];

/** Time-based hints while POST /api/cloud/install runs (no server progress yet). */
export const CLOUD_APP_INSTALL_PHASE_AFTER_MS: Record<
  CloudAppInstallPhase,
  number
> = {
  prepare: 0,
  source: 6_000,
  resources: 22_000,
  databases: 48_000,
  finalize: 95_000,
};

export function cloudAppInstallPhaseForElapsed(elapsedMs: number): CloudAppInstallPhase {
  let phase: CloudAppInstallPhase = "prepare";
  for (const candidate of CLOUD_APP_INSTALL_PHASES) {
    if (elapsedMs >= CLOUD_APP_INSTALL_PHASE_AFTER_MS[candidate]) {
      phase = candidate;
    }
  }
  return phase;
}

interface CloudAppInstallOverlayState {
  active: boolean;
  appName: string | null;
  startedAt: number | null;
  phase: CloudAppInstallPhase;
  begin: (appName: string) => void;
  end: () => void;
  tickPhase: (elapsedMs: number) => void;
}

export const useCloudAppInstallOverlayStore =
  create<CloudAppInstallOverlayState>((set, get) => ({
    active: false,
    appName: null,
    startedAt: null,
    phase: "prepare",
    begin: (appName) =>
      set({
        active: true,
        appName,
        startedAt: Date.now(),
        phase: "prepare",
      }),
    end: () =>
      set({
        active: false,
        appName: null,
        startedAt: null,
        phase: "prepare",
      }),
    tickPhase: (elapsedMs) => {
      if (!get().active) return;
      const next = cloudAppInstallPhaseForElapsed(elapsedMs);
      if (next !== get().phase) {
        set({ phase: next });
      }
    },
  }));

/** Imperative hooks for non-React callers (installCloudCatalogApp). */
export const cloudAppInstallOverlayActions = {
  begin: (appName: string) =>
    useCloudAppInstallOverlayStore.getState().begin(appName),
  end: () => useCloudAppInstallOverlayStore.getState().end(),
};
