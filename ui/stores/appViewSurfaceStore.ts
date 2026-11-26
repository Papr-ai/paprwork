/**
 * Which mini-apps are currently shown in their web (published) view.
 * Read by agentFocusContext so the agent knows local vs web for the open app.
 */
import { create } from "zustand";

export interface AppPillView {
  view: "live" | "preview";
  /** Reviewer trying one proposal in Preview. */
  proposal?: { id: string; title: string };
}

interface AppViewSurfaceState {
  web: Record<string, { webUrl?: string }>;
  setSurface: (appId: string, surface: "local" | "web", webUrl?: string) => void;
  /** Share bar v2: which view is open (absent = bar v2 off, or nothing to choose). */
  pill: Record<string, AppPillView>;
  setPillView: (appId: string, view: AppPillView | null) => void;
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
  pill: {},
  setPillView: (appId, view) =>
    set((state) => {
      const next = { ...state.pill };
      if (view) next[appId] = view;
      else delete next[appId];
      return { pill: next };
    }),
}));
