/**
 * Owner review of contribute-back PRs via Papr-issued per-app GitHub read tokens
 * (same credential path as inspect_cloud_repo — not the user's personal GitHub login).
 */

import { fetchAppRepoReadCredentials } from "./syncV3/AppRepoClient.js";
import {
  getCloudAppChangeRequestService,
  type CloudAppChangeRequestDetail,
} from "./CloudAppChangeRequestService.js";
import { parseGitHubOwnerRepo } from "./cloudSync/appWriterRepoObservability.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 80_000;

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function parsePullNumberFromPrUrl(prUrl: string | null | undefined): number | null {
  if (!prUrl?.trim()) {
    return null;
  }
  const match = prUrl.trim().match(/\/pull\/(\d+)\b/i);
  if (!match) {
    return null;
  }
  const n = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolvePullNumber(req: CloudAppChangeRequestDetail): number | null {
  if (typeof req.prNumber === "number" && req.prNumber > 0) {
    return req.prNumber;
  }
  return parsePullNumberFromPrUrl(req.prUrl);
}

async function githubJson<T>(
  url: string,
  token: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  const response = await fetch(url, { headers: githubHeaders(token) });
  const body = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body: body.slice(0, 400) };
  }
  return { ok: true, data: JSON.parse(body) as T };
}

async function resolveDefaultBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const result = await githubJson<{ default_branch?: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    token,
  );
  if (result.ok && result.data.default_branch?.trim()) {
    return result.data.default_branch.trim();
  }
  return "main";
}

export interface CloudAppChangeFileDiff {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  patchTruncated: boolean;
  patchOmittedByGitHub: boolean;
}

export interface CloudAppChangeReviewResult {
  request: {
    id: string;
    sourceAppId: string;
    title: string;
    description: string;
    status: string;
    branch: string | null;
    headSha: string | null;
    prNumber: number | null;
    stagedPaths: string[];
  };
  auth: {
    via: "papr-app-read-token";
    sourceAppId: string;
    expiresAt: string;
    note: string;
  };
  diff: {
    baseRef: string;
    headRef: string;
    files: CloudAppChangeFileDiff[];
    filesTruncated: boolean;
    totalPatchChars: number;
    patchBudgetExceeded: boolean;
  };
}

function truncatePatch(
  patch: string | undefined,
  remainingBudget: { chars: number },
  perFileMax: number,
): { text: string | null; truncated: boolean; omitted: boolean } {
  if (!patch?.trim()) {
    return { text: null, truncated: false, omitted: true };
  }
  let text = patch;
  let truncated = false;
  if (text.length > perFileMax) {
    text = `${text.slice(0, perFileMax)}\n\n… [patch truncated]`;
    truncated = true;
  }
  if (remainingBudget.chars <= 0) {
    return { text: null, truncated: false, omitted: true };
  }
  if (text.length > remainingBudget.chars) {
    text = `${text.slice(0, remainingBudget.chars)}\n\n… [total patch budget exceeded]`;
    truncated = true;
  }
  remainingBudget.chars -= text.length;
  return { text, truncated, omitted: false };
}

type PullFileRow = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  maxFiles: number,
): Promise<PullFileRow[]> {
  const rows: PullFileRow[] = [];
  let page = 1;
  while (rows.length < maxFiles) {
    const perPage = Math.min(100, maxFiles - rows.length);
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`;
    const result = await githubJson<PullFileRow[]>(url, token);
    if (!result.ok) {
      throw new Error(
        `GitHub pull files failed (${result.status}): ${result.body}`,
      );
    }
    if (result.data.length === 0) {
      break;
    }
    rows.push(...result.data);
    if (result.data.length < perPage) {
      break;
    }
    page += 1;
  }
  return rows.slice(0, maxFiles);
}

type CompareFileRow = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

async function fetchCompareFiles(
  owner: string,
  repo: string,
  baseRef: string,
  headRef: string,
  token: string,
  maxFiles: number,
): Promise<CompareFileRow[]> {
  const encoded = `${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${encoded}`;
  const result = await githubJson<{ files?: CompareFileRow[] }>(url, token);
  if (!result.ok) {
    throw new Error(`GitHub compare failed (${result.status}): ${result.body}`);
  }
  return (result.data.files ?? []).slice(0, maxFiles);
}

export async function buildCloudAppChangeReview(input: {
  requestId: string;
  maxFiles?: number;
  maxPatchCharsPerFile?: number;
  maxTotalPatchChars?: number;
}): Promise<CloudAppChangeReviewResult> {
  const requestId = input.requestId.trim();
  if (!requestId) {
    throw new Error("requestId is required");
  }

  const req = await getCloudAppChangeRequestService().getChangeRequest(requestId);
  if (!req) {
    throw new Error(
      `Change request ${requestId} not found in incoming list (may be resolved or id typo).`,
    );
  }

  const sourceAppId = req.sourceAppId.trim();
  const creds = await fetchAppRepoReadCredentials(sourceAppId);
  if (!creds) {
    throw new Error(
      `Per-app GitHub read token unavailable for upstream app ${sourceAppId}. ` +
        `Run get_cloud_sync_status({ appId: "${sourceAppId}" }) first.`,
    );
  }

  const { owner, repo } = parseGitHubOwnerRepo(creds.cloneUrl);
  const pullNumber = resolvePullNumber(req);
  const headRef =
    req.headSha?.trim() || req.branch?.trim() || (pullNumber ? `pull/${pullNumber}` : "");
  if (!headRef) {
    throw new Error(
      "Change request has no headSha, branch, or PR number — cannot load diff yet.",
    );
  }

  const baseRef = await resolveDefaultBranch(owner, repo, creds.token);
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const perFileMax = input.maxPatchCharsPerFile ?? DEFAULT_MAX_PATCH_CHARS;
  const totalBudget = { chars: input.maxTotalPatchChars ?? DEFAULT_MAX_TOTAL_PATCH_CHARS };

  const rawFiles = pullNumber
    ? await fetchPullRequestFiles(owner, repo, pullNumber, creds.token, maxFiles + 1)
    : await fetchCompareFiles(owner, repo, baseRef, headRef, creds.token, maxFiles + 1);

  const filesTruncated = rawFiles.length > maxFiles;
  const slice = rawFiles.slice(0, maxFiles);

  const files: CloudAppChangeFileDiff[] = slice.map((row) => {
    const path = row.filename?.trim() ?? "(unknown)";
    const { text, truncated, omitted } = truncatePatch(
      row.patch,
      totalBudget,
      perFileMax,
    );
    return {
      path,
      status: row.status?.trim() || "modified",
      additions: typeof row.additions === "number" ? row.additions : 0,
      deletions: typeof row.deletions === "number" ? row.deletions : 0,
      patch: text,
      patchTruncated: truncated,
      patchOmittedByGitHub: omitted,
    };
  });

  const totalPatchChars = files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);

  return {
    request: {
      id: req.id,
      sourceAppId: req.sourceAppId,
      title: req.title?.trim() || "(untitled)",
      description: req.description?.trim() || "",
      status: req.status,
      branch: req.branch?.trim() ?? null,
      headSha: req.headSha?.trim() ?? null,
      prNumber: pullNumber,
      stagedPaths: Array.isArray(req.stagedPaths)
        ? req.stagedPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [],
    },
    auth: {
      via: "papr-app-read-token",
      sourceAppId,
      expiresAt: creds.expiresAt,
      note:
        "Uses a short-lived Papr-issued GitHub token for the upstream app's writer repo (POST /read-token). " +
        "Not your personal GitHub OAuth or Settings API key.",
    },
    diff: {
      baseRef,
      headRef,
      files,
      filesTruncated,
      totalPatchChars,
      patchBudgetExceeded: totalBudget.chars <= 0,
    },
  };
}

export async function readCloudAppChangeFileAtHead(input: {
  requestId: string;
  relativePath: string;
  maxChars?: number;
}): Promise<{
  relativePath: string;
  ref: string;
  content: string;
  truncated: boolean;
}> {
  const req = await getCloudAppChangeRequestService().getChangeRequest(
    input.requestId.trim(),
  );
  if (!req) {
    throw new Error(`Change request ${input.requestId} not found`);
  }
  const ref = req.headSha?.trim() || req.branch?.trim();
  if (!ref) {
    throw new Error("Change request has no headSha or branch to read from");
  }

  const sourceAppId = req.sourceAppId.trim();
  const creds = await fetchAppRepoReadCredentials(sourceAppId);
  if (!creds) {
    throw new Error(`Per-app read token unavailable for app ${sourceAppId}`);
  }

  const { owner, repo } = parseGitHubOwnerRepo(creds.cloneUrl);
  const relativePath = input.relativePath.trim().replace(/^\/+/, "");
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const result = await githubJson<{ content?: string; encoding?: string }>(
    url,
    creds.token,
  );
  if (!result.ok) {
    throw new Error(`GitHub contents failed (${result.status}): ${result.body}`);
  }
  if (!result.data.content || result.data.encoding !== "base64") {
    throw new Error(`Path is not a file at ref ${ref}: ${relativePath}`);
  }

  const maxChars = input.maxChars ?? 50_000;
  const decoded = Buffer.from(result.data.content, "base64").toString("utf8");
  const truncated = decoded.length > maxChars;
  return {
    relativePath,
    ref,
    content: truncated ? decoded.slice(0, maxChars) : decoded,
    truncated,
  };
}
