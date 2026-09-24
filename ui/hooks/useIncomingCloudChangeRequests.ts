import { useCallback, useEffect, useState } from "react";
import {
  fetchIncomingCloudChangeRequests,
  type CloudChangeRequest,
} from "../utils/cloudChangeRequestsApi";

/** Owner-visible proposals still awaiting a decision (includes upload-in-progress). */
export function isIncomingChangeRequestOpen(
  req: CloudChangeRequest,
): boolean {
  const status = typeof req.status === "string" ? req.status.trim() : "";
  return status === "pending" || status === "preparing";
}

export function useIncomingCloudChangeRequests(sourceAppId: string | null): {
  requests: CloudChangeRequest[];
  /** Strict `pending` from the server. */
  pending: CloudChangeRequest[];
  /** Pending plus still-uploading proposals — drives inbox badge and list. */
  open: CloudChangeRequest[];
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
      if (
        detail?.type !== "cloud-sync:items-stale" &&
        detail?.type !== "cloud-change-requests:stale"
      ) {
        return;
      }
      void reload();
    };
    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [reload]);

  const pending = requests.filter((r) => r.status === "pending");
  const open = requests.filter(isIncomingChangeRequestOpen);

  return { requests, pending, open, loading, error, reload };
}
