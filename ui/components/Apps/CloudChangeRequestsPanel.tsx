/**
 * Owner panel — incoming contribute-back proposals for a published app.
 */

import { useCallback, useEffect, useState } from "react";
import {
  buildPrReviewAgentPrompt,
  openCloudSyncAgentChat,
} from "../../utils/openCloudSyncAgentChat";

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
  status: "preparing" | "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string | null;
  prUrl?: string | null;
  branch?: string | null;
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
      <p className="share-sheet__section-title">Suggested updates</p>
      <p className="share-sheet__section-desc">
        When someone installs your app and sends changes back, their proposal
        appears here. Review the update, then accept to merge it into your app
        or decline to close it.
      </p>

      {loading ? (
        <p className="share-sheet__footnote">Loading proposals…</p>
      ) : error ? (
        <p className="share-sheet__error">{error}</p>
      ) : pending.length === 0 ? (
        <p className="share-sheet__footnote">No pending proposals.</p>
      ) : (
        <ul className="share-sheet__changes-list">
          {pending.map((req) => (
            <li key={req.id} className="share-sheet__changes-item">
              <div className="share-sheet__changes-head">
                <strong>{req.title}</strong>
              </div>
              <p className="share-sheet__changes-desc">{req.description}</p>
              {req.prUrl ? (
                <p className="share-sheet__changes-meta">
                  <a
                    className="share-sheet__link-btn"
                    href={req.prUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Review proposed changes
                  </a>
                </p>
              ) : (
                <p className="share-sheet__footnote">
                  Waiting for change upload to finish…
                </p>
              )}
              <div className="share-sheet__changes-actions">
                <button
                  type="button"
                  className="share-sheet__secondary-btn"
                  disabled={busy || !req.prUrl}
                  onClick={() => {
                    openCloudSyncAgentChat(
                      buildPrReviewAgentPrompt({
                        sourceAppId: req.sourceAppId,
                        title: req.title,
                        description: req.description,
                        prUrl: req.prUrl,
                      }),
                    );
                  }}
                >
                  Review with agent
                </button>
                <button
                  type="button"
                  className="share-sheet__primary-btn"
                  disabled={busy || resolvingId === req.id || !req.prUrl}
                  title={
                    req.prUrl
                      ? "Merge this proposal into your app"
                      : "Available once the proposal upload completes"
                  }
                  onClick={() => void resolve(req.id, "approve")}
                >
                  {resolvingId === req.id ? "Working…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="share-sheet__secondary-btn"
                  disabled={busy || resolvingId === req.id}
                  onClick={() => void resolve(req.id, "reject")}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {requests.some((r) => r.status !== "pending") ? (
        <p className="share-sheet__footnote">
          {requests.filter((r) => r.status === "approved").length} accepted ·{" "}
          {requests.filter((r) => r.status === "rejected").length} declined
        </p>
      ) : null}
    </div>
  );
}
