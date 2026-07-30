/**
 * Platform feedback — bug reports and feature requests for Papr Work.
 *
 * Production path: POST /v1/platform-feedback/issues on the memory server
 * (GitHub token stays server-side; client sends PAPR_API_KEY only).
 *
 * Dev fallback: PAPR_GITHUB_ISSUE_TOKEN in gateway env for local testing only.
 */

import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getPaprApiKey } from "../utils/keyResolver.js";

export const PLATFORM_FEEDBACK_ISSUES_PATH = "/v1/platform-feedback/issues";

const DEFAULT_REPO = "Papr-ai/paprwork";

export type PlatformIssueType = "bug" | "feature";

export interface CreatePlatformIssueInput {
  type: PlatformIssueType;
  title: string;
  body: string;
  contactEmail?: string;
}

export interface CreatePlatformIssueResult {
  issueNumber: number;
  issueUrl: string;
  title: string;
  /** Where the issue was created (for logging / agent messaging). */
  via: "memory-server" | "dev-github-token";
}

export interface PlatformFeedbackEnvironment {
  appVersion: string;
  platform: string;
  isPackaged: boolean;
  installId?: string;
}

export class PlatformFeedbackNotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Platform feedback is not available. Log in with Papr (Settings → AI Models) " +
          "or paste the draft at https://github.com/Papr-ai/paprwork/issues",
    );
    this.name = "PlatformFeedbackNotConfiguredError";
  }
}

function getDevGitHubToken(): string | null {
  return process.env.PAPR_GITHUB_ISSUE_TOKEN?.trim() || null;
}

export function getPlatformFeedbackEnvironment(): PlatformFeedbackEnvironment {
  const installId = process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID?.trim();
  return {
    appVersion: process.env.PAPRWORK_APP_VERSION ?? "unknown",
    platform: process.platform,
    isPackaged: process.env.PAPRWORK_IS_PACKAGED === "true",
    ...(installId ? { installId } : {}),
  };
}

export function buildPlatformIssueBody(
  input: CreatePlatformIssueInput,
): string {
  const env = getPlatformFeedbackEnvironment();
  const sections = [input.body.trim()];

  const meta: string[] = [
    "## Environment",
    `- **App version:** ${env.appVersion}`,
    `- **Platform:** ${env.platform}`,
    `- **Packaged:** ${env.isPackaged ? "yes" : "no"}`,
  ];

  if (env.installId) {
    meta.push(
      `- **Install ID:** \`${env.installId}\` (anonymous, for support correlation)`,
    );
  }

  if (input.contactEmail?.trim()) {
    meta.push(`- **Contact:** ${input.contactEmail.trim()}`);
  }

  sections.push("", ...meta);
  sections.push("", "---", "*Submitted via Papr Work in-app feedback*");

  return sections.join("\n");
}

function labelForType(type: PlatformIssueType): string {
  return type === "bug" ? "bug" : "enhancement";
}

/** True when memory-server submit (Papr login) or dev-only direct GitHub token is available. */
export async function canSubmitPlatformIssue(): Promise<boolean> {
  const paprKey = await getPaprApiKey();
  if (paprKey) return true;
  return Boolean(getDevGitHubToken());
}

interface MemoryServerIssueResponse {
  issueNumber: number;
  issueUrl: string;
  title: string;
}

async function submitViaMemoryServer(
  input: CreatePlatformIssueInput,
): Promise<CreatePlatformIssueResult> {
  const response = await cloudApiFetch(PLATFORM_FEEDBACK_ISSUES_PATH, {
    method: "POST",
    body: {
      type: input.type,
      title: input.title.trim(),
      body: input.body.trim(),
      contactEmail: input.contactEmail?.trim() || undefined,
      environment: getPlatformFeedbackEnvironment(),
    },
    timeoutMs: 30_000,
  });

  if (response.status === 401 || response.status === 403) {
    throw new PlatformFeedbackNotConfiguredError(
      "Papr login required to submit feedback. Open Settings → AI Models → Login with Papr, then try again.",
    );
  }

  if (response.status === 404 || response.status === 501) {
    throw new Error(
      "Platform feedback API is not enabled on the memory server yet. " +
        "Prepare a draft for the user to paste at https://github.com/Papr-ai/paprwork/issues",
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Memory server feedback error (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as MemoryServerIssueResponse;
  if (
    typeof data.issueNumber !== "number" ||
    typeof data.issueUrl !== "string" ||
    typeof data.title !== "string"
  ) {
    throw new Error("Memory server returned an invalid platform feedback response");
  }

  return {
    issueNumber: data.issueNumber,
    issueUrl: data.issueUrl,
    title: data.title,
    via: "memory-server",
  };
}

/** Dev-only: direct GitHub API when PAPR_GITHUB_ISSUE_TOKEN is set locally. */
async function submitViaDevGitHubToken(
  input: CreatePlatformIssueInput,
): Promise<CreatePlatformIssueResult> {
  const token = getDevGitHubToken();
  if (!token) {
    throw new PlatformFeedbackNotConfiguredError();
  }

  const response = await fetch(
    `https://api.github.com/repos/${DEFAULT_REPO}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Paprwork-Platform-Feedback-Dev",
      },
      body: JSON.stringify({
        title: input.title.trim(),
        body: buildPlatformIssueBody(input),
        labels: [labelForType(input.type)],
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub API error (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as {
    number: number;
    html_url: string;
    title: string;
  };

  return {
    issueNumber: data.number,
    issueUrl: data.html_url,
    title: data.title,
    via: "dev-github-token",
  };
}

/**
 * Submit platform feedback. Prefers memory server when Papr API key is available.
 */
export async function submitPlatformIssue(
  input: CreatePlatformIssueInput,
): Promise<CreatePlatformIssueResult> {
  const paprKey = await getPaprApiKey();
  if (paprKey) {
    try {
      return await submitViaMemoryServer(input);
    } catch (error) {
      if (getDevGitHubToken()) {
        console.warn(
          "[PlatformFeedback] Memory server submit failed, using dev GitHub token:",
          (error as Error).message.slice(0, 120),
        );
        return submitViaDevGitHubToken(input);
      }
      throw error;
    }
  }

  if (getDevGitHubToken()) {
    return submitViaDevGitHubToken(input);
  }

  throw new PlatformFeedbackNotConfiguredError();
}

/** @deprecated Use canSubmitPlatformIssue — dev token check only, sync. */
export function isPlatformIssueSubmissionConfigured(): boolean {
  return Boolean(getDevGitHubToken());
}

/** @deprecated Use submitPlatformIssue — dev direct GitHub only. */
export async function createPlatformGitHubIssue(
  input: CreatePlatformIssueInput,
): Promise<CreatePlatformIssueResult> {
  const result = await submitViaDevGitHubToken(input);
  return result;
}
