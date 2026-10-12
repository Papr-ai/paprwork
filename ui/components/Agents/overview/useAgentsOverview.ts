import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../../src/lib/gateway";
import type { AgentsOverview } from "../../../../src/core/types/agentsOverview";

/**
 * Last payload per range: in memory for tab switches, in localStorage across
 * launches. The page paints the last known numbers at once and refreshes
 * behind them, so "Loading" only shows the very first time.
 */
const cache = new Map<number, AgentsOverview>();
const STORAGE_KEY = (days: number) => `papr.agentsOverview.v1.${days}`;

function readStored(days: number): AgentsOverview | null {
  if (cache.has(days)) return cache.get(days)!;
  try {
    const raw = localStorage.getItem(STORAGE_KEY(days));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentsOverview;
    cache.set(days, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(days: number, data: AgentsOverview): void {
  cache.set(days, data);
  try {
    localStorage.setItem(STORAGE_KEY(days), JSON.stringify(data));
  } catch {
    /* quota or private mode: memory cache still works */
  }
}

export function useAgentsOverview(days: number, visible: boolean) {
  const [data, setData] = useState<AgentsOverview | null>(() => readStored(days));
  const [loading, setLoading] = useState(() => !readStored(days));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!readStored(days)) setLoading(true);
    try {
      const res = await gateway.send("agent:get-overview", { days });
      if (res.success && res.data) {
        const next = res.data as AgentsOverview;
        writeStored(days, next);
        setData(next);
        setError(null);
      } else {
        setError(res.error ?? "Could not load agent usage");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load agent usage");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    setData(readStored(days));
    if (visible) void load();
  }, [days, visible, load]);

  return { data, loading, error, reload: load };
}
