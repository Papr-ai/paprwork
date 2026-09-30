import { useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";
import { DEFAULT_HOME_APP_ID } from "../constants/defaultHomeApp";

interface AppListItem {
  id: string;
}

interface UseDefaultHomeAppResult {
  appId: string | null;
  loading: boolean;
}

function resolveConfiguredHomeAppId(
  preferences: { defaultHomeAppId?: string } | undefined,
): string {
  const configured = preferences?.defaultHomeAppId?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_HOME_APP_ID;
}

export function useDefaultHomeApp(): UseDefaultHomeAppResult {
  const [appId, setAppId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const settingsResponse = await gateway.send("settings:get", {});
        const targetAppId = resolveConfiguredHomeAppId(
          settingsResponse?.data?.preferences as
            | { defaultHomeAppId?: string }
            | undefined,
        );

        const appsResponse = await gateway.send("app:list", {});
        const apps = (appsResponse?.data ?? []) as AppListItem[];
        const exists = apps.some((app) => app.id === targetAppId);

        if (!cancelled) {
          setAppId(exists ? targetAppId : null);
        }
      } catch (error) {
        console.error("[useDefaultHomeApp] Failed to resolve home app:", error);
        if (!cancelled) {
          setAppId(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { appId, loading };
}
