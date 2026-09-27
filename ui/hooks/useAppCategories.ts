/**
 * Broad app categories (Jev-sorted) for the filter pills on Library, Team and
 * Community. The gateway owns the list; this hook just reads it and asks the
 * gateway to categorize whatever is on screen. Never blocks the grid.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface AppCategory {
  name: string;
  definition: string;
  count: number;
}

export interface CategoriesSnapshot {
  categories: AppCategory[];
  byKey: Record<string, string | null>;
  version: number;
}

export interface CategorizeItem {
  key: string;
  title: string;
  description?: string;
  tags?: string[];
}

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

const EMPTY: CategoriesSnapshot = { categories: [], byKey: {}, version: 0 };

/** Shared across views so Library / Team / Community stay in sync. */
let shared: CategoriesSnapshot = EMPTY;
/** True while the first-ever library sort is running (nothing stored yet). */
let firstRun = false;
const listeners = new Set<(s: CategoriesSnapshot) => void>();
function publish(next: CategoriesSnapshot): void {
  shared = next;
  listeners.forEach((l) => l(next));
}

async function post(path: string, body: unknown): Promise<CategoriesSnapshot | null> {
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as CategoriesSnapshot;
  } catch {
    return null;
  }
}

export function useAppCategories(): {
  snapshot: CategoriesSnapshot;
  /** Reserve space for the pill row: first sort is running, nothing to show yet. */
  sorting: boolean;
  syncLibrary: () => void;
  categorize: (items: CategorizeItem[], scope: "team" | "community") => void;
  assign: (key: string, category: string | null) => void;
} {
  const [snapshot, setSnapshot] = useState<CategoriesSnapshot>(shared);
  const inflight = useRef<string>("");

  useEffect(() => {
    listeners.add(setSnapshot);
    if (shared === EMPTY) {
      void fetch(`${GATEWAY}/api/apps/categories`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: CategoriesSnapshot | null) => s && publish(s))
        .catch(() => undefined);
    }
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);

  const syncLibrary = useCallback(() => {
    const first = Object.keys(shared.byKey).length === 0;
    if (first) {
      firstRun = true;
      publish({ ...shared });
    }
    void post("/api/apps/categories/sync", {}).then((s) => {
      firstRun = false;
      publish(s ?? { ...shared });
    });
  }, []);

  const categorize = useCallback((items: CategorizeItem[], scope: "team" | "community") => {
    const todo = items.filter((i) => !(i.key in shared.byKey));
    const sig = todo.map((i) => i.key).join("|");
    if (!todo.length || inflight.current === sig) return;
    inflight.current = sig;
    void post("/api/apps/categories/categorize", { items: todo, scope }).then((s) => s && publish(s));
  }, []);

  const assign = useCallback((key: string, category: string | null) => {
    publish({ ...shared, byKey: { ...shared.byKey, [key]: category } });
    void post("/api/apps/categories/assign", { key, category }).then((s) => s && publish(s));
  }, []);

  return { snapshot, sorting: firstRun && Object.keys(snapshot.byKey).length === 0, syncLibrary, categorize, assign };
}
