/**
 * ChatGPT (Codex) subscription usage — 5h / weekly windows plus credit balance.
 *
 * `GET https://chatgpt.com/backend-api/wham/usage` with the ChatGPT OAuth
 * bearer and, when we have it, `ChatGPT-Account-Id`. This is the same endpoint
 * the Codex CLI polls; the ChatGPT backend does not return `x-ratelimit-*`
 * headers, and the `x-codex-*` header family it used to emit is no longer sent
 * on the `/responses` stream, so polling is the only source available to us.
 *
 * Undocumented, like the Claude equivalent in `claudeOAuthUsage.ts`. Parsing is
 * therefore tolerant: an unrecognised payload yields zero rows rather than
 * throwing, because the caller's fallback for "could not read the plan" is to
 * say so, and that is strictly better than a crash or a fabricated number.
 */

export type CodexUsageLimitRow = {
  id: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: "normal" | "warning" | "critical" | string;
  isActive: boolean;
};

export type CodexUsageLimitsSnapshot = {
  fetchedAt: string;
  source: "chatgpt_backend";
  rows: CodexUsageLimitRow[];
  /**
   * Whether spend continues past the included windows.
   *
   * ChatGPT's analogue of Claude's `extra_usage.is_enabled` is prepaid
   * credits: past the included window a request either draws on a credit
   * balance the user bought — real money — or is refused outright. See
   * `readExtraUsageEnabled` for why `unlimited` is not treated as spend.
   */
  extraUsageEnabled: boolean | null;
  /** e.g. "$5.00", shown only as context; never used to decide the basis. */
  creditBalance: string | null;
  subscriptionType: string | null;
};

export type FetchCodexUsageResult =
  | { success: true; data: CodexUsageLimitsSnapshot }
  | { success: false; error: string; httpStatus?: number };

const CHATGPT_BACKEND_BASE = "https://chatgpt.com/backend-api";

/** 5h window in the payload; matched by duration, not by key name. */
const PRIMARY_WINDOW_SECONDS = 18_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isoFromResetAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  // `reset_at` is Unix *seconds*; passing it to Date unscaled lands in 1970.
  return new Date(value * 1000).toISOString();
}

/**
 * The window keys differ across Codex builds (`primary_window` in the CLI's
 * Rust structs, `primary` in the payloads OpenUsage documents), so both names
 * are accepted rather than betting on one.
 */
function readWindow(
  rateLimit: Record<string, unknown>,
  names: string[],
): Record<string, unknown> | null {
  for (const name of names) {
    const block = asRecord(rateLimit[name]);
    if (block) return block;
  }
  return null;
}

/**
 * Window label.
 *
 * Derived from `limit_window_seconds` where present so a relabelled or
 * reordered payload still reads correctly, falling back to the slot's
 * conventional meaning. Kept in the wording used for Claude
 * ("Current session" / "All models") so a single `PlanUsageSummary` parser
 * downstream recognises both providers without a provider branch.
 */
function labelForWindow(
  block: Record<string, unknown>,
  slot: "primary" | "secondary",
): { id: string; label: string } {
  const seconds = block.limit_window_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    return seconds <= PRIMARY_WINDOW_SECONDS
      ? { id: "session", label: "Current session" }
      : { id: "weekly_all", label: "All models" };
  }
  return slot === "primary"
    ? { id: "session", label: "Current session" }
    : { id: "weekly_all", label: "All models" };
}

/**
 * Does spend continue past the included window?
 *
 * - `has_credits: true` — the request draws on credits the user paid for, so
 *   it costs money on top of the plan. This is the case the cost UI exists
 *   for and the one that must never read as "included".
 * - `has_credits: false` — past the window the backend refuses rather than
 *   billing, so nothing is spent.
 * - `unlimited: true` — an entitlement, not a bill. Requests continue with no
 *   per-turn charge, so this is *not* spend; reporting it as overage would
 *   invent a charge that is not happening.
 * - neither present — unknown, and saying so beats guessing either way.
 */
function readExtraUsageEnabled(
  credits: Record<string, unknown> | null,
): boolean | null {
  if (!credits) return null;
  if (credits.unlimited === true) return false;
  if (typeof credits.has_credits === "boolean") return credits.has_credits;
  return null;
}

export function parseCodexUsagePayload(body: unknown): CodexUsageLimitsSnapshot {
  const root = asRecord(body) ?? {};
  const rateLimit = asRecord(root.rate_limit) ?? {};
  const rows: CodexUsageLimitRow[] = [];

  const slots: Array<{ slot: "primary" | "secondary"; names: string[] }> = [
    { slot: "primary", names: ["primary_window", "primary"] },
    { slot: "secondary", names: ["secondary_window", "secondary"] },
  ];

  for (const { slot, names } of slots) {
    const block = readWindow(rateLimit, names);
    if (!block) continue;
    const percent = clampPercent(block.used_percent);
    if (percent === null) continue;
    const { id, label } = labelForWindow(block, slot);
    rows.push({
      id,
      label,
      percent,
      resetsAt: isoFromResetAt(block.reset_at),
      severity: "normal",
      // The payload marks no window as "active", and a window at 0% is still
      // a live constraint, so every window we could read counts as active.
      isActive: true,
    });
  }

  const credits = asRecord(rateLimit.credits);
  const balance =
    credits && typeof credits.balance === "string" ? credits.balance : null;

  return {
    fetchedAt: new Date().toISOString(),
    source: "chatgpt_backend",
    rows,
    extraUsageEnabled: readExtraUsageEnabled(credits),
    creditBalance: balance,
    subscriptionType:
      typeof root.plan_type === "string" ? root.plan_type : null,
  };
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  const root = asRecord(body);
  if (!root) return fallback;
  const err = asRecord(root.error);
  if (err && typeof err.message === "string") return err.message;
  if (typeof root.message === "string") return root.message;
  if (typeof root.detail === "string") return root.detail;
  return fallback;
}

/**
 * `/backend-api` bases take `/wham/usage`; anything else (a self-hosted or
 * proxied Codex backend) takes `/api/codex/usage`. Same payload either way.
 */
export function codexUsageUrl(base: string = CHATGPT_BACKEND_BASE): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.includes("/backend-api")
    ? `${trimmed}/wham/usage`
    : `${trimmed}/api/codex/usage`;
}

export async function fetchCodexSubscriptionUsage(
  accessToken: string,
  options?: { accountId?: string; baseUrl?: string },
): Promise<FetchCodexUsageResult> {
  const token = accessToken.trim();
  if (!token) {
    return { success: false, error: "Missing ChatGPT OAuth access token" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options?.accountId) {
    headers["ChatGPT-Account-Id"] = options.accountId;
  }

  let response: Response;
  try {
    response = await fetch(codexUsageUrl(options?.baseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "ChatGPT usage request failed",
    };
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text.slice(0, 400) };
    }
  }

  if (!response.ok) {
    return {
      success: false,
      error: errorMessageFromBody(
        body,
        `ChatGPT usage request failed (${response.status})`,
      ),
      httpStatus: response.status,
    };
  }

  const data = parseCodexUsagePayload(body);
  if (data.rows.length === 0) {
    // A 200 we cannot read is not a success: reporting an empty plan would
    // render as 0% used, which is the most misleading number available.
    return {
      success: false,
      error: "ChatGPT returned no readable usage windows",
      httpStatus: response.status,
    };
  }
  return { success: true, data };
}
