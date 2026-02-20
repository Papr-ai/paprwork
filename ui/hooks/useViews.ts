/**
 * useViews - Fetch all app data views (tables by app)
 *
 * Used by ViewsView to display tables organized by app.
 */

import { useState, useCallback, useEffect } from "react";
import { gateway } from "../src/lib/gateway";

export interface AppViewEntry {
  appId: string;
  appTitle: string;
  sources: Array<{
    sourceId: string;
    alias: string;
    tables: Array<{ table: string }>;
  }>;
}

export function useViews() {
  const [apps, setApps] = useState<AppViewEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadViews = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("db:list-all-views", {});
      const data = response.data as { apps: AppViewEntry[] };
      setApps(data?.apps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load views");
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadViews();
  }, [loadViews]);

  return { apps, loading, error, reload: loadViews };
}
