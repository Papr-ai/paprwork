import { useCallback, useEffect, useState } from "react";
import {
  fetchIncomingCloudChangeRequests,
  type CloudChangeRequest,
} from "../utils/cloudChangeRequestsApi";

export function useIncomingCloudChangeRequests(sourceAppId: string | null): {
  requests: CloudChangeRequest[];
  pending: CloudChangeRequest[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [requests, setRequests] = useState<CloudChangeRequest[]>([]);
  const [loading, setLoading] = useState(Boolean(sourceAppId));
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sourceAppId) {
      setRequests([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const all = await fetchIncomingCloudChangeRequests();
      setRequests(all.filter((r) => r.sourceAppId === sourceAppId));
    } catch (err) {
      setError((err as Error).message);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [sourceAppId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Contributions are a web fact, so they refresh on the same 5-min tick as the
  // web sync check rather than on their own timer or only when the panel opens.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { type?: string }
        | undefined;
      if (detail?.type !== "cloud-sync:items-stale") return;
      void reload();
    };
    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [reload]);

  const pending = requests.filter((r) => r.status === "pending");

  return { requests, pending, loading, error, reload };
}
