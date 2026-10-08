/**
 * Contribute-back change requests for cloud-installed forks.
 */

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface SubmitCloudAppChangeInput {
  sourceNamespaceId: string;
  sourceSlug: string;
  installedAppId: string;
  title: string;
  description: string;
  /** Maintainer/Admin: merge into the app now instead of waiting for review. */
  publishNow?: boolean;
}

export interface SubmitCloudAppChangeResult {
  id: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  headSha?: string;
  status?: string;
  publishedDirectly?: boolean;
  publishNote?: string;
}

export type SourceAppRole = "viewer" | "contributor" | "maintainer" | "admin" | "none";

/** Your role on the app this copy came from; null when unknown. */
export async function fetchSourceAppRole(installedAppId: string): Promise<SourceAppRole | null> {
  try {
    const res = await fetch(
      `${GATEWAY}/api/cloud/apps/${encodeURIComponent(installedAppId)}/source-role`,
    );
    if (!res.ok) return null;
    return ((await res.json()) as { role?: SourceAppRole | null }).role ?? null;
  } catch {
    return null;
  }
}

export async function submitCloudAppChange(
  input: SubmitCloudAppChangeInput,
): Promise<SubmitCloudAppChangeResult> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as SubmitCloudAppChangeResult & {
    error?: string;
    code?: string;
    conflictFiles?: string[];
  };
  if (!res.ok) {
    if (body.code === "needs_update") {
      throw new ProposeNeedsUpdateError(
        body.error ?? "Get updates first",
        body.conflictFiles ?? [],
      );
    }
    throw new Error(body.error ?? `Failed (${res.status})`);
  }
  return body;
}

/** The owner changed files you also edited: resolve with Get updates, then send again. */
export class ProposeNeedsUpdateError extends Error {
  constructor(
    message: string,
    readonly conflictFiles: string[],
  ) {
    super(message);
    this.name = "ProposeNeedsUpdateError";
  }
}

export type SentProposalStatus =
  | "preparing"
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

export interface SentProposal {
  id: string;
  title: string;
  description: string;
  status: SentProposalStatus;
  /** Pending only: "conflict" = the owner can't accept it until it's updated. */
  mergeState?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  stagedPaths?: string[] | null;
}

/** Proposals you sent from this installed copy, newest first. */
export async function listSentProposals(installedAppId: string): Promise<SentProposal[]> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/apps/changes/outgoing?installedAppId=${encodeURIComponent(installedAppId)}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { requests?: SentProposal[] };
  return (body.requests ?? []).filter((r) => r.status !== "preparing");
}
