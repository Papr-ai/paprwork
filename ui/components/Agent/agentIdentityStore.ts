/**
 * Your primary agent's identity: one name, one look, one color.
 * Pen + the Papr mark in Papr blue is the default, so nothing changes until the user personalizes.
 * Stored locally (per device) — purely presentational.
 */
import { create } from "zustand";

export type AgentLook = "papr" | "orb" | "tile" | "hex";
export type AgentColor = "blue" | "violet" | "amber" | "mint" | "graphite";

export interface AgentIdentity {
  look: AgentLook;
  color: AgentColor;
  name: string;
}

export const AGENT_LOOKS: ReadonlyArray<{ id: AgentLook; label: string }> = [
  { id: "papr", label: "Papr" },
  { id: "orb", label: "Orb" },
  { id: "tile", label: "Tile" },
  { id: "hex", label: "Hex" },
];

/** Three-stop gradients; blue is the Papr brand gradient (#0060E0 → #00ACFA → #0BCDFF). */
export const AGENT_COLORS: ReadonlyArray<{ id: AgentColor; label: string; stops: [string, string, string] }> = [
  { id: "blue", label: "Papr blue", stops: ["#0060E0", "#00ACFA", "#0BCDFF"] },
  { id: "violet", label: "Violet", stops: ["#7C3AED", "#C026D3", "#F472B6"] },
  { id: "amber", label: "Amber", stops: ["#F97316", "#F59E0B", "#FCD34D"] },
  { id: "mint", label: "Mint", stops: ["#059669", "#10B981", "#5EEAD4"] },
  { id: "graphite", label: "Graphite", stops: ["#1E293B", "#475569", "#94A3B8"] },
];

export const DEFAULT_AGENT: AgentIdentity = { look: "papr", color: "blue", name: "Pen" };
export const AGENT_NAME_MAX = 16;
const STORAGE_KEY = "paprwork-agent-identity";

export function agentStops(color: AgentColor): [string, string, string] {
  return (AGENT_COLORS.find((c) => c.id === color) ?? AGENT_COLORS[0]).stops;
}

function isLook(v: unknown): v is AgentLook {
  return AGENT_LOOKS.some((l) => l.id === v);
}

function isColor(v: unknown): v is AgentColor {
  return AGENT_COLORS.some((c) => c.id === v);
}

function load(): AgentIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AGENT;
    const parsed = JSON.parse(raw) as Partial<AgentIdentity>;
    return {
      look: isLook(parsed.look) ? parsed.look : DEFAULT_AGENT.look,
      color: isColor(parsed.color) ? parsed.color : DEFAULT_AGENT.color,
      name: typeof parsed.name === "string" ? parsed.name.slice(0, AGENT_NAME_MAX) : DEFAULT_AGENT.name,
    };
  } catch {
    return DEFAULT_AGENT;
  }
}

function save(identity: AgentIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Storage full or unavailable — identity still applies for this session.
  }
}

interface AgentIdentityState extends AgentIdentity {
  sheetOpen: boolean;
  update: (patch: Partial<AgentIdentity>) => void;
  reset: () => void;
  openSheet: () => void;
  closeSheet: () => void;
}

export const useAgentIdentity = create<AgentIdentityState>((set, get) => ({
  ...load(),
  sheetOpen: false,
  update: (patch) => {
    set(patch);
    const { look, color, name } = get();
    save({ look, color, name });
  },
  reset: () => {
    set(DEFAULT_AGENT);
    save(DEFAULT_AGENT);
  },
  openSheet: () => set({ sheetOpen: true }),
  closeSheet: () => {
    // An emptied name falls back to Pen rather than leaving the agent nameless.
    if (!get().name.trim()) get().update({ name: DEFAULT_AGENT.name });
    set({ sheetOpen: false });
  },
}));

/** Display name with the Pen fallback — use everywhere the agent is labelled. */
export function useAgentName(): string {
  return useAgentIdentity((s) => s.name.trim() || DEFAULT_AGENT.name);
}
