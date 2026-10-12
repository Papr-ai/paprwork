import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../../src/lib/gateway";
import type { AgentsOverview } from "../../../../src/core/types/agentsOverview";

/** Last payload per range, so reopening the tab paints instantly. */
const cache = new Map<number, AgentsOverview>();

export function useAgentsOverview(days: number, visible: boolean) {
  const [data, setData] = useState<AgentsOverview | null>(cache.get(days) ?? null);
  const [loading, setLoading] = useState(!cache.has(days));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cache.has(days)) setLoading(true);
    try {
      const res = await gateway.send("agent:get-overview", { days });
      if (res.success && res.data) {
        const next = res.data as AgentsOverview;
        cache.set(days, next);
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
    setData(cache.get(days) ?? null);
    if (visible) void load();
  }, [days, visible, load]);

  return { data, loading, error, reload: load };
}
