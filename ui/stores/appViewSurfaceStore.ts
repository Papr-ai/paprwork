/**
 * Which mini-apps are currently shown in their web (published) view.
 * Read by agentFocusContext so the agent knows local vs web for the open app.
 */
import { create } from "zustand";

interface AppViewSurfaceState {
  web: Record<string, { webUrl?: string }>;
  setSurface: (appId: string, surface: "local" | "web", webUrl?: string) => void;
}

export const useAppViewSurfaceStore = create<AppViewSurfaceState>((set) => ({
  web: {},
  setSurface: (appId, surface, webUrl) =>
    set((state) => {
      const next = { ...state.web };
      if (surface === "web") next[appId] = { webUrl };
      else delete next[appId];
      return { web: next };
    }),
}));
