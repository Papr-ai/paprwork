/**
 * Propose sheet body — send edits to the publisher, then see what you sent.
 *
 * No GitHub links: the publisher's repo is private, so a PR URL would 404 for
 * the contributor. Status comes from the memory server's outgoing list.
 */

import { useCallback, useEffect, useState } from "react";
import {
  listSentProposals,
  ProposeNeedsUpdateError,
  fetchSourceAppRole,
  submitCloudAppChange,
  type SourceAppRole,
  type SentProposal,
} from "../../utils/cloudContributeApi";

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

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting for review", tone: "warn" },
  approved: { label: "Accepted", tone: "ok" },
  rejected: { label: "Declined", tone: "bad" },
};

function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

export function CloudContributeBackPanel({
  appTitle,
  lineage,
  busy = false,
}: CloudContributeBackPanelProps) {
  const [title, setTitle] = useState(`Updates to ${appTitle}`);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<SentProposal[] | null>(null);
  const [role, setRole] = useState<SourceAppRole | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Maintainers and Admins may publish straight into the app (roles plan).
  const canPublish = role === "maintainer" || role === "admin";

  useEffect(() => {
    void fetchSourceAppRole(lineage.installedAppId).then(setRole);
  }, [lineage.installedAppId]);

  const loadProposals = useCallback(async () => {
    try {
      setProposals(await listSentProposals(lineage.installedAppId));
    } catch {
      setProposals([]);
    }
  }, [lineage.installedAppId]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const submit = async (publishNow = false) => {
    if (!description.trim()) {
      setError("Add a short summary of what you changed");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSent(false);
    setNote(null);
    try {
      const result = await submitCloudAppChange({
        sourceNamespaceId: lineage.sourceNamespaceId,
        sourceSlug: lineage.sourceSlug,
        installedAppId: lineage.installedAppId,
        title: title.trim(),
        description: description.trim(),
        publishNow,
      });
      if (result.publishedDirectly) {
        setNote("Published to the app.");
      } else if (result.publishNote) {
        setNote(result.publishNote);
      }
      setSent(true);
      setDescription("");
      void loadProposals();
    } catch (err) {
      if (err instanceof ProposeNeedsUpdateError && err.conflictFiles.length > 0) {
        const files = err.conflictFiles.slice(0, 3).join(", ");
        const more = err.conflictFiles.length > 3 ? ` +${err.conflictFiles.length - 3} more` : "";
        setError(`${err.message} (${files}${more})`);
      } else {
        setError((err as Error).message.slice(0, 160));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="share-sheet__section share-sheet__fork">
      <p className="share-sheet__section-desc">
        {canPublish
          ? "Publish your edits straight into the app, or send them for review first. Your copy stays as it is."
          : "Send your edits to the owner. They can accept them into the main app or decline; either way your copy stays as it is."}
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
        onChange={(e) => {
          setDescription(e.target.value);
          if (sent) setSent(false);
        }}
        disabled={busy || submitting}
      />

      {error ? <p className="share-sheet__error">{error}</p> : null}
      {note ? <p className="share-sheet__section-desc">{note}</p> : null}

      {canPublish ? (
        <button
          type="button"
          className="share-sheet__primary-btn"
          disabled={busy || submitting}
          onClick={() => void submit(true)}
        >
          {submitting ? "Publishing…" : "Publish now"}
        </button>
      ) : null}
      <button
        type="button"
        className={canPublish ? "share-sheet__secondary-btn" : "share-sheet__primary-btn"}
        disabled={busy || submitting}
        onClick={() => void submit(false)}
      >
        {submitting && !canPublish ? "Sending proposal…" : sent && !note ? "Sent ✓" : canPublish ? "Send for review" : "Send to owner"}
      </button>

      {proposals && proposals.length > 0 ? (
        <div className="propose-history">
          <p className="propose-history__heading">Your proposals</p>
          <ul className="propose-history__list">
            {proposals.map((p) => {
              const status = STATUS_LABEL[p.status] ?? { label: p.status, tone: "idle" };
              const when =
                p.status === "pending" ? relativeTime(p.createdAt) : relativeTime(p.resolvedAt ?? p.createdAt);
              const files = p.stagedPaths?.length ?? 0;
              return (
                <li key={p.id} className="propose-history__item">
                  <div className="propose-history__main">
                    <span className="propose-history__title" title={p.description}>
                      {p.title}
                    </span>
                    <span className="propose-history__meta">
                      {when}
                      {files > 0 ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                  <span className={`propose-history__status propose-history__status--${status.tone}`}>
                    <span className="propose-history__dot" aria-hidden />
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
