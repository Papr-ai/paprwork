/**
 * ⌘K scope — search follows where you are. Opened from Focus or Memory, the palette starts scoped
 * to the agent's memory (a removable chip); anywhere else it searches commands and apps only.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { useTabStore } from "../../stores/tabStore";
import type { WikiNode } from "../../types/wiki";

export interface PaletteScope {
  id: "focus" | "memory";
  label: string;
}

/** Scope for the tab the user is looking at (left pane in split view). */
export function scopeForActiveTab(): PaletteScope | null {
  const { tabs, activeLeftTab, activeTabId } = useTabStore.getState();
  const tab = tabs.find((t) => t.id === (activeLeftTab ?? activeTabId));
  if (tab?.type === "focus") return { id: "focus", label: "Focus" };
  if (tab?.type === "memory") return { id: "memory", label: "Memory" };
  return null;
}

/** Debounced memory search while a scope is set. Stale responses are dropped. */
export function useScopedMemorySearch(scope: PaletteScope | null, query: string) {
  const [results, setResults] = useState<WikiNode[]>([]);
  const [loading, setLoading] = useState(false);
  const q = query.trim();

  useEffect(() => {
    if (!scope || !q) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await gateway.send("memory:wiki-search", { query: q });
        const found = (response.data as { results?: WikiNode[] } | undefined)?.results ?? [];
        if (!cancelled) setResults(found.slice(0, 8));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scope, q]);

  return { results, loading };
}
