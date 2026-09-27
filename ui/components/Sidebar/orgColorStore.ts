/**
 * Org color — a per-workspace accent drawn as a ring around the rail avatar so you can
 * tell at a glance which org you're in. Keyed by org (workspace) id; each org gets a stable
 * default from the palette and can be recolored from the account card. Stored locally.
 */
import { create } from "zustand";

export const ORG_SWATCHES = [
  "#0161E0", "#00ACFA", "#7C3AED", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#64748B",
] as const;

const STORAGE_KEY = "paprwork-org-colors";

function load(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Stable default per workspace so two orgs rarely share a color before anyone picks one. */
function defaultColor(key: string): string {
  if (!key) return ORG_SWATCHES[0];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ORG_SWATCHES[h % ORG_SWATCHES.length];
}

interface OrgColorState {
  colors: Record<string, string>;
  setColor: (key: string, color: string) => void;
}

export const useOrgColors = create<OrgColorState>((set, get) => ({
  colors: load(),
  setColor: (key, color) => {
    if (!key) return;
    const colors = { ...get().colors, [key]: color };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    } catch {
      // Ignore storage errors
    }
    set({ colors });
  },
}));

export function orgColorFor(key: string, colors: Record<string, string>): string {
  return colors[key] ?? defaultColor(key);
}

export function useOrgColor(key: string): string {
  return useOrgColors((s) => s.colors[key]) ?? defaultColor(key);
}
