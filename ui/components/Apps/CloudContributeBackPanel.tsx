/**
 * Fork/track panel — pull upstream updates (track) or contribute back (fork/track).
 */

import { useState } from "react";
import {
  formatLastSyncedAt,
  formatTrackSyncSummary,
  pullTrackUpstream,
  type TrackSyncResult,
} from "../../utils/cloudTrackSyncApi";

export interface ForkLineageInfo {
  mode: "fork" | "track";
  sourceAppId: string;
  sourceSlug: string;
  sourceNamespaceId: string;
  installedAppId: string;
  lastSyncedAt?: string;
}

interface CloudContributeBackPanelProps {
  appTitle: string;
  lineage: ForkLineageInfo;
  busy?: boolean;
  onTrackPullComplete?: (result: TrackSyncResult) => void;
}

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export function CloudContributeBackPanel({
  appTitle,
  lineage,
  busy = false,
  onTrackPullComplete,
}: CloudContributeBackPanelProps) {
  const [title, setTitle] = useState(`Updates to ${appTitle}`);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(lineage.lastSyncedAt);

  const modeLabel = lineage.mode === "track" ? "Tracking upstream" : "Fork";
  const lastSyncedLabel = formatLastSyncedAt(lastSyncedAt);

  const pullUpstream = async () => {
    setPulling(true);
    setError(null);
    setMessage(null);
    try {
      const result = await pullTrackUpstream(lineage.installedAppId);
      setLastSyncedAt(result.lastSyncedAt);
      setMessage(formatTrackSyncSummary(result));
      onTrackPullComplete?.(result);
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setPulling(false);
    }
  };

  const submit = async () => {
    if (!description.trim()) {
      setError("Describe what you changed");
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`${GATEWAY}/api/cloud/apps/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceNamespaceId: lineage.sourceNamespaceId,
          sourceSlug: lineage.sourceSlug,
          installedAppId: lineage.installedAppId,
          title: title.trim(),
          description: description.trim(),
        }),
      });
      const body = (await res.json()) as { error?: string; id?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setMessage("Change request sent to the owner for review.");
      setDescription("");
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="share-sheet__section share-sheet__fork">
      <p className="share-sheet__section-title">
        {modeLabel} · from cloud
      </p>
      <p className="share-sheet__section-desc">
        Installed from{" "}
        <strong>
          {lineage.sourceSlug} ({lineage.sourceAppId.slice(0, 8)}…)
        </strong>
        . Your copy stays local — API keys and data are yours.
      </p>

      {lineage.mode === "track" ? (
        <div className="share-sheet__track-pull">
          <p className="share-sheet__track-pull-desc">
            When the publisher updates their app, pull their latest code here.
            Files you edited locally are kept — overlapping changes are skipped
            as conflicts.
          </p>
          {lastSyncedLabel ? (
            <p className="share-sheet__footnote">
              Last pulled {lastSyncedLabel}
            </p>
          ) : (
            <p className="share-sheet__footnote">Not pulled since install</p>
          )}
          <button
            type="button"
            className="share-sheet__secondary-btn"
            disabled={busy || pulling}
            onClick={() => void pullUpstream()}
          >
            {pulling ? "Pulling from publisher…" : "Pull latest from publisher"}
          </button>
        </div>
      ) : null}

      <label className="share-sheet__field-label" htmlFor="change-title">
        Request title
      </label>
      <input
        id="change-title"
        className="share-sheet__text-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy || submitting}
      />

      <label className="share-sheet__field-label" htmlFor="change-desc">
        What changed?
      </label>
      <textarea
        id="change-desc"
        className="share-sheet__textarea"
        rows={4}
        placeholder="Describe fixes or features you want the owner to review…"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy || submitting}
      />

      {error ? <p className="share-sheet__error">{error}</p> : null}
      {message ? (
        <p className="share-sheet__notice share-sheet__notice--success">{message}</p>
      ) : null}

      <button
        type="button"
        className="share-sheet__primary-btn"
        disabled={busy || submitting}
        onClick={() => void submit()}
      >
        {submitting ? "Sending…" : "Send changes to owner"}
      </button>
    </div>
  );
}
