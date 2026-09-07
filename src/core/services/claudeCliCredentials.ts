/**
 * Parsing for Claude Code's stored OAuth credentials.
 *
 * Claude Code keeps a JSON blob (macOS Keychain entry "Claude Code-credentials",
 * or ~/.claude/.credentials.json elsewhere) holding three fields that all matter:
 * a short-lived `accessToken`, the long-lived `refreshToken` that is the only way
 * to mint a new one, and `expiresAt`. Paprwork used to keep the access token and
 * invent the other two, which is why a Claude account could look connected for a
 * year and start returning 401 the same afternoon.
 */

/** Anthropic access tokens; short-lived, sent as the bearer credential. */
const ACCESS_TOKEN_PREFIX = "sk-ant-oat";

export interface ClaudeCliCredentials {
  accessToken: string;
  /** Absent when the source did not provide one (e.g. a pasted setup-token). */
  refreshToken?: string;
  /** Epoch milliseconds. Absent when the source did not provide one. */
  expiresAt?: number;
}

export interface OAuthTokenLifetimeFields {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function readExpiresAt(source: Record<string, unknown>): number | undefined {
  const raw = source.expiresAt ?? source.expires_at;

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // Claude Code writes epoch milliseconds. Treating a seconds value as
    // milliseconds would date the expiry to 1970 and mark every token dead.
    return raw < 1e12 ? raw * 1000 : raw;
  }

  if (typeof raw === "string") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return undefined;
}

/**
 * Read credentials out of one of Claude Code's storage shapes. Returns null when
 * the blob carries no access token, so callers can fall through to the next
 * source rather than adopting a half-empty record.
 */
export function parseClaudeCliCredentials(
  raw: string | null | undefined,
): ClaudeCliCredentials | null {
  if (!raw || raw.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  // Keychain and ~/.claude/.credentials.json nest under claudeAiOauth;
  // ~/.claude.json uses oauthAccount; older writers used the root.
  const candidates = [parsed.claudeAiOauth, parsed.oauthAccount, parsed].filter(
    isRecord,
  );

  for (const candidate of candidates) {
    const accessToken = cleanToken(
      candidate.accessToken ?? candidate.access_token,
    );
    if (!accessToken) continue;

    return {
      accessToken,
      refreshToken: cleanToken(
        candidate.refreshToken ?? candidate.refresh_token,
      ),
      expiresAt: readExpiresAt(candidate),
    };
  }

  return null;
}

/**
 * Whether a stored refresh token can actually be exchanged for a new access
 * token. A refresh grant only accepts a refresh token, so posting an access
 * token into that field fails — and echoing the access token is exactly what
 * the old connect path stored.
 */
export function isUsableRefreshToken(
  refreshToken: string | undefined,
  accessToken: string,
): boolean {
  // Callers include stored records that never went through cleanToken, so a
  // blank value has to be rejected here rather than assumed away.
  const candidate = refreshToken?.trim();
  if (!candidate) return false;
  if (candidate === accessToken.trim()) return false;
  if (candidate.startsWith(ACCESS_TOKEN_PREFIX)) return false;
  return true;
}

/**
 * Map credentials onto the fields `OAuthTokenStorage.storeToken` requires.
 *
 * `fallbackTtlSeconds` is only consulted when the source gave us no expiry, so
 * every assumed lifetime is declared by the caller rather than hidden in here.
 * A past `expiresAt` yields a negative `expiresIn` on purpose: that records the
 * token as already expired and lets the refresh path pick it up.
 */
export function claudeCredentialsToTokenLifetime(
  credentials: ClaudeCliCredentials,
  options: { fallbackTtlSeconds: number; now?: number },
): OAuthTokenLifetimeFields {
  const now = options.now ?? Date.now();
  const hasUsableRefresh = isUsableRefreshToken(
    credentials.refreshToken,
    credentials.accessToken,
  );

  return {
    accessToken: credentials.accessToken,
    // storeToken requires a string. Echoing the access token keeps that
    // contract; isUsableRefreshToken is what stops the refresh path from
    // attempting a grant that cannot succeed.
    refreshToken: hasUsableRefresh
      ? (credentials.refreshToken as string)
      : credentials.accessToken,
    expiresIn:
      credentials.expiresAt !== undefined
        ? Math.round((credentials.expiresAt - now) / 1000)
        : options.fallbackTtlSeconds,
  };
}
