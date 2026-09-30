/**
 * Propose sheet body — send edits to the publisher, then see what you sent.
 *
 * No GitHub links: the publisher's repo is private, so a PR URL would 404 for
 * the contributor. Status comes from the memory server's outgoing list.
 */

import { useCallback, useEffect, useState } from "react";
import {
  listSentProposals,
  submitCloudAppChange,
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

  const submit = async () => {
    if (!description.trim()) {
      setError("Add a short summary of what you changed");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSent(false);
    try {
      await submitCloudAppChange({
        sourceNamespaceId: lineage.sourceNamespaceId,
        sourceSlug: lineage.sourceSlug,
        installedAppId: lineage.installedAppId,
        title: title.trim(),
        description: description.trim(),
      });
      setSent(true);
      setDescription("");
      void loadProposals();
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="share-sheet__section share-sheet__fork">
      <p className="share-sheet__section-desc">
        Send your edits to the owner. They can accept them into the main app or
        decline; either way your copy stays as it is.
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

      <button
        type="button"
        className="share-sheet__primary-btn"
        disabled={busy || submitting}
        onClick={() => void submit()}
      >
        {submitting ? "Sending proposal…" : sent ? "Sent ✓" : "Send to owner"}
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
