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
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modeLabel = lineage.mode === "track" ? "Tracking upstream" : "Fork";

  const submit = async () => {
    if (!description.trim()) {
      setError("Add a short summary of what you changed");
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    setPrUrl(null);
    try {
      const result = await submitCloudAppChange({
        sourceNamespaceId: lineage.sourceNamespaceId,
        sourceSlug: lineage.sourceSlug,
        installedAppId: lineage.installedAppId,
        title: title.trim(),
        description: description.trim(),
      });
      setMessage("Your proposal was sent to the app owner for review.");
      if (result.prUrl) {
        setPrUrl(result.prUrl);
      }
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
        Send your edits back to the original publisher for review. They can
        accept your changes into the main app or decline without affecting your
        local copy.
      </p>

      <label className="share-sheet__field-label" htmlFor="change-title">
        Proposal title
      </label>
      <input
        id="change-title"
        className="share-sheet__text-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy || submitting}
      />

      <label className="share-sheet__field-label" htmlFor="change-desc">
        What did you change?
      </label>
      <textarea
        id="change-desc"
        className="share-sheet__textarea"
        rows={4}
        placeholder="Briefly explain the fix or feature you want the owner to review…"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy || submitting}
      />

      {error ? <p className="share-sheet__error">{error}</p> : null}
      {message ? (
        <p className="share-sheet__notice share-sheet__notice--success">{message}</p>
      ) : null}
      {prUrl ? (
        <p className="share-sheet__footnote">
          <a className="share-sheet__link-btn" href={prUrl} target="_blank" rel="noreferrer">
            View proposed changes
          </a>
        </p>
      ) : null}

      <button
        type="button"
        className="share-sheet__primary-btn"
        disabled={busy || submitting}
        onClick={() => void submit()}
      >
        {submitting ? "Sending proposal…" : "Send to owner"}
      </button>
    </div>
  );
}
