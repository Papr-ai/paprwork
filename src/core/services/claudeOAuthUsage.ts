/**
 * Claude Pro/Max subscription usage (5h / weekly limits).
 *
 * Primary: GET https://api.anthropic.com/api/oauth/usage (Bearer OAuth access token).
 * Fallback: GET https://claude.ai/api/organizations/{org}/usage (same JSON shape as web UI).
 *
 * Not documented by Anthropic; same endpoints Claude Code / claude.ai settings use.
 */

export type ClaudeUsageLimitRow = {
  id: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: "normal" | "warning" | "critical" | string;
  isActive: boolean;
};

export type ClaudeUsageLimitsSnapshot = {
  fetchedAt: string;
  source: "oauth" | "web";
  rows: ClaudeUsageLimitRow[];
  extraUsageEnabled: boolean | null;
  /** Which credential succeeded (Claude Code Keychain vs Paprwork paste store). */
  credentialSource?: "claude_code_keychain" | "papr_stored";
  subscriptionType?: string | null;
  orgName?: string | null;
};

export type FetchClaudeUsageResult =
  | { success: true; data: ClaudeUsageLimitsSnapshot }
  | { success: false; error: string; httpStatus?: number };

/** Query params match Claude Code's internal usage fetch (see CLI binary). */
const OAUTH_USAGE_URL =
  "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1";
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

type RawUtilizationBlock = {
  utilization?: number;
  resets_at?: string | null;
};

type RawLimitEntry = {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  is_active?: boolean;
  resets_at?: string | null;
  scope?: {
    model?: { display_name?: string | null; id?: string | null };
    surface?: unknown;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPercent(block: RawUtilizationBlock | null): number {
  if (!block) {
    return 0;
  }
  const u = block.utilization;
  if (typeof u !== "number" || !Number.isFinite(u)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(u)));
}

function labelForLimit(entry: RawLimitEntry): string {
  const kind = entry.kind ?? "";
  if (kind === "session" || entry.group === "session") {
    return "Current session";
  }
  if (kind === "weekly_all") {
    return "All models";
  }
  if (kind === "weekly_scoped") {
    const name = entry.scope?.model?.display_name?.trim();
    if (name) {
      return name;
    }
    return "Model-specific weekly";
  }
  return kind || "Limit";
}

function idForLimit(entry: RawLimitEntry, index: number): string {
  const kind = entry.kind ?? `limit-${index}`;
  const model = entry.scope?.model?.display_name ?? "";
  return `${kind}:${model}`;
}

/** Parse claude.ai / oauth usage JSON into display rows. */
export function parseClaudeUsagePayload(
  body: unknown,
  source: "oauth" | "web",
): ClaudeUsageLimitsSnapshot {
  const root = asRecord(body) ?? {};
  const rows: ClaudeUsageLimitRow[] = [];

  const limitsRaw = root.limits;
  if (Array.isArray(limitsRaw) && limitsRaw.length > 0) {
    limitsRaw.forEach((item, index) => {
      const entry = asRecord(item) as RawLimitEntry | null;
      if (!entry) {
        return;
      }
      const percent =
        typeof entry.percent === "number"
          ? Math.max(0, Math.min(100, Math.round(entry.percent)))
          : 0;
      rows.push({
        id: idForLimit(entry, index),
        label: labelForLimit(entry),
        percent,
        resetsAt:
          typeof entry.resets_at === "string" ? entry.resets_at : null,
        severity: entry.severity ?? "normal",
        isActive: entry.is_active === true,
      });
    });
  } else {
    const fiveHour = asRecord(root.five_hour) as RawUtilizationBlock | null;
    const sevenDay = asRecord(root.seven_day) as RawUtilizationBlock | null;
    if (fiveHour) {
      rows.push({
        id: "session",
        label: "Current session",
        percent: readPercent(fiveHour),
        resetsAt:
          typeof fiveHour.resets_at === "string" ? fiveHour.resets_at : null,
        severity: "normal",
        isActive: true,
      });
    }
    if (sevenDay) {
      rows.push({
        id: "weekly_all",
        label: "All models",
        percent: readPercent(sevenDay),
        resetsAt:
          typeof sevenDay.resets_at === "string" ? sevenDay.resets_at : null,
        severity: "normal",
        isActive: true,
      });
    }
  }

  const extra = asRecord(root.extra_usage);
  const extraEnabled =
    extra && typeof extra.is_enabled === "boolean" ? extra.is_enabled : null;

  return {
    fetchedAt: new Date().toISOString(),
    source,
    rows,
    extraUsageEnabled: extraEnabled,
  };
}

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  };
}

async function readJsonResponse(
  response: Response,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text.slice(0, 400) };
    }
  }
  return { ok: response.ok, status: response.status, body, text };
}

function extractOrgUuid(profile: unknown): string | undefined {
  const root = asRecord(profile);
  if (!root) {
    return undefined;
  }
  const direct =
    root.organization_uuid ??
    root.organizationUuid ??
    root.org_uuid ??
    root.orgUuid;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const org = asRecord(root.organization);
  if (org && typeof org.uuid === "string") {
    return org.uuid;
  }
  const memberships = root.memberships;
  if (Array.isArray(memberships)) {
    for (const item of memberships) {
      const m = asRecord(item);
      const orgRec = m ? asRecord(m.organization) : null;
      if (orgRec && typeof orgRec.uuid === "string") {
        return orgRec.uuid;
      }
    }
  }
  return undefined;
}

async function fetchOAuthUsage(
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const response = await fetch(OAUTH_USAGE_URL, {
    method: "GET",
    headers: oauthHeaders(accessToken),
    signal: AbortSignal.timeout(20_000),
  });
  return readJsonResponse(response);
}

async function fetchOAuthUsageWithRetry(
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  let attempt = await fetchOAuthUsage(accessToken);
  if (attempt.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    attempt = await fetchOAuthUsage(accessToken);
  }
  if (attempt.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempt = await fetchOAuthUsage(accessToken);
  }
  return attempt;
}

async function fetchOAuthProfile(
  accessToken: string,
): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(OAUTH_PROFILE_URL, {
    method: "GET",
    headers: oauthHeaders(accessToken),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await readJsonResponse(response);
  return { ok: parsed.ok, body: parsed.body };
}

async function fetchWebOrgUsage(
  accessToken: string,
  orgUuid: string,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const url = `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/usage`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-client-platform": "web_claude_ai",
    },
    signal: AbortSignal.timeout(20_000),
  });
  return readJsonResponse(response);
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  const root = asRecord(body);
  if (!root) {
    return fallback;
  }
  const err = asRecord(root.error);
  if (err && typeof err.message === "string") {
    return err.message;
  }
  if (typeof root.message === "string") {
    return root.message;
  }
  return fallback;
}

export type FetchClaudeUsageOptions = {
  /** From `claude auth status --json` when profile API is unavailable. */
  orgUuidHint?: string;
  credentialSource?: ClaudeUsageLimitsSnapshot["credentialSource"];
  subscriptionType?: string | null;
  orgName?: string | null;
};

function attachMeta(
  data: ClaudeUsageLimitsSnapshot,
  options?: FetchClaudeUsageOptions,
): ClaudeUsageLimitsSnapshot {
  return {
    ...data,
    credentialSource: options?.credentialSource,
    subscriptionType: options?.subscriptionType ?? null,
    orgName: options?.orgName ?? null,
  };
}

export async function fetchClaudeSubscriptionUsage(
  accessToken: string,
  options?: FetchClaudeUsageOptions,
): Promise<FetchClaudeUsageResult> {
  const trimmed = accessToken.trim();
  if (!trimmed) {
    return { success: false, error: "Missing OAuth access token" };
  }

  const oauthAttempt = await fetchOAuthUsageWithRetry(trimmed);
  if (oauthAttempt.ok) {
    return {
      success: true,
      data: attachMeta(
        parseClaudeUsagePayload(oauthAttempt.body, "oauth"),
        options,
      ),
    };
  }

  let lastStatus = oauthAttempt.status;
  let lastError = errorMessageFromBody(
    oauthAttempt.body,
    `OAuth usage request failed (${oauthAttempt.status})`,
  );

  let orgUuid = options?.orgUuidHint;
  if (!orgUuid && (oauthAttempt.status === 401 || oauthAttempt.status === 403)) {
    const profileAttempt = await fetchOAuthProfile(trimmed);
    if (profileAttempt.ok) {
      orgUuid = extractOrgUuid(profileAttempt.body);
    }
  }

  if (orgUuid && (oauthAttempt.status === 401 || oauthAttempt.status === 403)) {
    const webAttempt = await fetchWebOrgUsage(trimmed, orgUuid);
    lastStatus = webAttempt.status;
    if (webAttempt.ok) {
      return {
        success: true,
        data: attachMeta(
          parseClaudeUsagePayload(webAttempt.body, "web"),
          options,
        ),
      };
    }
    lastError = errorMessageFromBody(
      webAttempt.body,
      `Web usage request failed (${webAttempt.status})`,
    );
  }

  return {
    success: false,
    error: lastError,
    httpStatus: lastStatus,
  };
}

/** Try Claude Code token first, then Paprwork — same APIs Claude Code uses. */
export async function fetchClaudeSubscriptionUsageFromCandidates(
  candidates: { accessToken: string; source: NonNullable<ClaudeUsageLimitsSnapshot["credentialSource"]> }[],
  context?: {
    orgUuidHint?: string;
    subscriptionType?: string | null;
    orgName?: string | null;
  },
): Promise<FetchClaudeUsageResult & { attempts?: string[] }> {
  if (candidates.length === 0) {
    return {
      success: false,
      error: "No Claude OAuth token available",
    };
  }

  const attempts: string[] = [];
  for (const candidate of candidates) {
    const result = await fetchClaudeSubscriptionUsage(candidate.accessToken, {
      orgUuidHint: context?.orgUuidHint,
      credentialSource: candidate.source,
      subscriptionType: context?.subscriptionType,
      orgName: context?.orgName,
    });
    if (result.success) {
      return { ...result, attempts };
    }
    attempts.push(`${candidate.source}: ${result.error}`);
  }

  return {
    success: false,
    error: attempts.join(" · "),
    attempts,
  };
}
