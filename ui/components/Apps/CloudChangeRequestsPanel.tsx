/**
 * Owner panel — incoming contribute-back change requests for a published app.
 */

import { useCallback, useEffect, useState } from "react";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

interface ChangeRequest {
  id: string;
  sourceAppId: string;
  sourceSlug: string;
  installedAppId: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string | null;
}

interface CloudChangeRequestsPanelProps {
  sourceAppId: string;
  busy?: boolean;
}

export function CloudChangeRequestsPanel({
  sourceAppId,
  busy = false,
}: CloudChangeRequestsPanelProps) {
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/cloud/apps/changes/incoming`);
      const body = (await res.json()) as {
        requests?: ChangeRequest[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      const filtered = (body.requests ?? []).filter(
        (r) => r.sourceAppId === sourceAppId,
      );
      setRequests(filtered);
    } catch (err) {
      setError((err as Error).message.slice(0, 120));
    } finally {
      setLoading(false);
    }
  }, [sourceAppId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (requestId: string, action: "approve" | "reject") => {
    setResolvingId(requestId);
    setError(null);
    try {
      const res = await fetch(
        `${GATEWAY}/api/cloud/apps/changes/${requestId}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      await load();
    } catch (err) {
      setError((err as Error).message.slice(0, 120));
    } finally {
      setResolvingId(null);
    }
  };

  const pending = requests.filter((r) => r.status === "pending");

  return (
    <div className="share-sheet__section share-sheet__changes">
      <p className="share-sheet__section-title">Change requests</p>
      <p className="share-sheet__section-desc">
        When someone forks your app and sends changes back, they appear here for
        your review. Approving merges their local fork into your published app.
      </p>

      {loading ? (
        <p className="share-sheet__footnote">Loading requests…</p>
      ) : error ? (
        <p className="share-sheet__error">{error}</p>
      ) : pending.length === 0 ? (
        <p className="share-sheet__footnote">No pending change requests.</p>
      ) : (
        <ul className="share-sheet__changes-list">
          {pending.map((req) => (
            <li key={req.id} className="share-sheet__changes-item">
              <div className="share-sheet__changes-head">
                <strong>{req.title}</strong>
                <span className="share-sheet__changes-meta">
                  fork {req.installedAppId.slice(0, 8)}…
                </span>
              </div>
              <p className="share-sheet__changes-desc">{req.description}</p>
              <div className="share-sheet__changes-actions">
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={busy || resolvingId === req.id}
                  onClick={() => void resolve(req.id, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="share-sheet__secondary-btn"
                  disabled={busy || resolvingId === req.id}
                  onClick={() => void resolve(req.id, "reject")}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {requests.some((r) => r.status !== "pending") ? (
        <p className="share-sheet__footnote">
          {requests.filter((r) => r.status === "approved").length} approved ·{" "}
          {requests.filter((r) => r.status === "rejected").length} rejected
        </p>
      ) : null}
    </div>
  );
}
