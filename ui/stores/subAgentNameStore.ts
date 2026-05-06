/**
 * SubAgent Name Store — Lightweight Zustand store for resolving agent names.
 *
 * WHY THIS EXISTS:
 * Previously, every <MessageItem> called the `useSubAgents()` hook, which
 * created its own useState + setInterval per instance.  In a chat with 300+
 * messages that meant 300+ independent IPC round-trips on mount and 600+
 * polling calls every 15 s — enough to starve the main thread and make
 * typing visibly laggy.
 *
 * This store replaces that pattern with a single shared subscription:
 *   • One gateway call on first access
 *   • One 30 s polling interval (agent names rarely change)
 *   • All components read from the same Zustand slice — zero extra re-renders
 *     unless the agent list actually changes
 */

import { create } from "zustand";
import { gateway } from "../src/lib/gateway";

interface SubAgentNameState {
  /** Map of agentId → display name (populated lazily) */
  agentNames: Map<string, string>;
  /** Whether the initial load has completed */
  loaded: boolean;
  /** Resolve an agent ID to its display name, falling back to the raw ID */
  getAgentName: (agentId: string) => string;
}

/** Singleton polling handle so we never start two intervals */
let pollingTimer: ReturnType<typeof setInterval> | null = null;

async function fetchAgentNames(): Promise<Map<string, string>> {
  try {
    const response = (await gateway.send("subagent:list")) as {
      agents?: Array<{ id: string; name: string }>;
    };
    const map = new Map<string, string>();
    if (Array.isArray(response?.agents)) {
      for (const a of response.agents) {
        map.set(a.id, a.name);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export const useSubAgentNameStore = create<SubAgentNameState>((set, get) => {
  // Kick off the first load + polling immediately when the store is created
  // (store creation is lazy — happens on first import/use)
  void fetchAgentNames().then((names) => {
    set({ agentNames: names, loaded: true });
  });

  if (!pollingTimer) {
    pollingTimer = setInterval(() => {
      void fetchAgentNames().then((names) => {
        const prev = get().agentNames;
        // Only update if something actually changed (avoids unnecessary re-renders)
        if (
          names.size !== prev.size ||
          [...names].some(([k, v]) => prev.get(k) !== v)
        ) {
          set({ agentNames: names });
        }
      });
    }, 30_000);
  }

  return {
    agentNames: new Map(),
    loaded: false,
    getAgentName: (agentId: string) => {
      return get().agentNames.get(agentId) ?? agentId;
    },
  };
});
