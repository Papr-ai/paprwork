/**
 * Fork/track panel — contribute changes back to the upstream owner (Share sheet).
 */

import { useState } from "react";
import { submitCloudAppChange } from "../../utils/cloudContributeApi";

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
}

export function CloudContributeBackPanel({
  appTitle,
  lineage,
  busy = false,
}: CloudContributeBackPanelProps) {
  const [title, setTitle] = useState(`Updates to ${appTitle}`);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modeLabel = lineage.mode === "track" ? "Tracking upstream" : "Fork";

  const submit = async () => {
    if (!description.trim()) {
      setError("Describe what you changed");
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      await submitCloudAppChange({
        sourceNamespaceId: lineage.sourceNamespaceId,
        sourceSlug: lineage.sourceSlug,
        installedAppId: lineage.installedAppId,
        title: title.trim(),
        description: description.trim(),
      });
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
        . Use <strong>Propose</strong> in the bar above to suggest edits to
        the owner, or pull their updates when tracking upstream.
      </p>

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
