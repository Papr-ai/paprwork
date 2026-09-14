const MAX_BACKOFF_MS = 60_000;

/** Automatic silent retries before surfacing the Resume UI (2 retries = 3 total attempts). */
export const MAX_PROVIDER_RATE_LIMIT_RETRIES = 2;

export const RATE_LIMIT_EXHAUSTED_ERROR_CODE = "rate_limit_exhausted";

/**
 * A limit that will not clear by waiting a moment, so Resume cannot fix it.
 * Carries its own code because the UI's response has to differ: Resume is the
 * right affordance for a burst limit and a false promise for a spent month.
 */
export const PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE = "provider_quota_exhausted";

/** Which knob the user has to turn to get working again. */
export type QuotaRemedy =
  | "subscription_quota"
  | "api_spend_cap"
  | "api_credits";

/** Which credential the request actually went out with. */
export type CredentialKind = "oauth" | "apiKey" | "unknown";

export interface CredentialDescriptor {
  /** `anthropic`, `openai`, `openai-codex`, … Absent is fine; the kind still reads. */
  provider?: string;
  kind: CredentialKind;
}

/**
 * Read the credential kind off the token itself.
 *
 * Deliberately not read back from the auth-mode setting: the question a user
 * asks after flipping that toggle is "did that take effect", and a label
 * sourced from the same setting they just changed agrees with them whether or
 * not the switch reached the request. The token is the only witness to what
 * was actually sent.
 */
export function classifyCredentialToken(
  token: string | undefined,
): CredentialKind {
  const value = token?.trim();
  if (!value) return "unknown";
  // OAuth shapes first: `sk-oat…` would otherwise be caught by the `sk-` key rule.
  if (
    value.startsWith("sk-ant-oat") ||
    value.startsWith("sk-ant-ort") ||
    value.startsWith("sk-oat")
  ) {
    return "oauth";
  }
  if (value.includes("eyJ") && value.split(".").length >= 3) return "oauth";
  if (value.startsWith("sk-")) return "apiKey";
  return "unknown";
}

const CREDENTIAL_COPY: Record<
  "anthropic" | "openai" | "other",
  { oauth: string; apiKey: string; providerName: string }
> = {
  anthropic: {
    oauth: "your Claude subscription login",
    apiKey: "your Anthropic API key",
    providerName: "Anthropic",
  },
  openai: {
    oauth: "your ChatGPT subscription login",
    apiKey: "your OpenAI API key",
    providerName: "OpenAI",
  },
  other: {
    oauth: "your subscription login",
    apiKey: "your API key",
    providerName: "The AI provider",
  },
};

function credentialCopyFor(provider?: string) {
  const key = provider?.toLowerCase() ?? "";
  if (key.includes("anthropic") || key.includes("claude")) {
    return CREDENTIAL_COPY.anthropic;
  }
  if (key.includes("openai") || key.includes("codex")) {
    return CREDENTIAL_COPY.openai;
  }
  return CREDENTIAL_COPY.other;
}

/** "your Claude subscription login" — undefined when the token said nothing. */
export function describeCredentialInUse(
  credential?: CredentialDescriptor,
): string | undefined {
  if (!credential || credential.kind === "unknown") return undefined;
  const copy = credentialCopyFor(credential.provider);
  return credential.kind === "oauth" ? copy.oauth : copy.apiKey;
}

/**
 * The other credential for the same provider — the switch the user is most
 * likely reaching for, and the one worth naming so they can see it is not the
 * one that just failed.
 */
export function describeAlternativeCredential(
  credential?: CredentialDescriptor,
): string | undefined {
  if (!credential || credential.kind === "unknown") return undefined;
  const copy = credentialCopyFor(credential.provider);
  return credential.kind === "oauth" ? copy.apiKey : copy.oauth;
}

export interface ProviderQuotaExhaustion {
  remedy: QuotaRemedy;
  /** The provider's own sentence, verbatim — it is the ground truth. */
  providerMessage?: string;
  /** When access returns, when the provider bothered to say. */
  resetsAt?: Date;
}

export function createRateLimitExhaustedError(
  error?: unknown,
  credential?: CredentialDescriptor,
): {
  type: "stream_pause";
  code: typeof RATE_LIMIT_EXHAUSTED_ERROR_CODE;
  message: string;
} {
  // A burst limit really does clear on its own, so Resume is honest here. The
  // provider's sentence is still worth passing along when it says something
  // more specific than "429".
  return {
    type: "stream_pause",
    code: RATE_LIMIT_EXHAUSTED_ERROR_CODE,
    message: describeProviderRateLimit(error, credential, { resumable: true }),
  };
}

/**
 * A transient limit, described so the user can tell one refusal from the next.
 *
 * Naming the credential is the point, not decoration: two credentials can be
 * refused at the same time for unrelated reasons, and a message that names
 * neither reads identically before and after the user switches between them —
 * indistinguishable from the switch never having taken effect.
 *
 * `resumable` exists because only the pi-ai route raises this alongside a
 * Resume button. Telling anyone else to tap Resume names a control that is not
 * on their screen.
 */
export function describeProviderRateLimit(
  error: unknown,
  credential?: CredentialDescriptor,
  options?: { resumable?: boolean },
): string {
  const providerMessage = error ? extractProviderSentence(error) : undefined;
  const inUse = describeCredentialInUse(credential);
  const alternative = describeAlternativeCredential(credential);
  const retry = options?.resumable
    ? "Tap Resume when ready to continue."
    : "Wait a moment and try again.";

  const headline = inUse
    ? `${credentialCopyFor(credential?.provider).providerName} rate-limited ${inUse}, so the reply never started.`
    : "The AI provider is rate limited.";

  const action = alternative
    ? `${retry} If it keeps happening, switch model — or switch to ${alternative} in Settings → AI Models.`
    : retry;

  // The unattributed case stays one sentence: structure is only worth adding
  // once there is something specific to put in it.
  const lines = inUse ? [headline, action] : [`${headline} ${action}`];
  if (providerMessage) lines.push(`Provider said: “${providerMessage}”`);
  return lines.join("\n\n");
}

export function createProviderQuotaExhaustedError(
  detail: ProviderQuotaExhaustion,
  credential?: CredentialDescriptor,
): {
  type: "stream_pause";
  code: typeof PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE;
  message: string;
} {
  return {
    type: "stream_pause",
    code: PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE,
    message: describeQuotaExhaustion(detail, credential),
  };
}

function collectErrorStrings(error: unknown, depth = 0): string[] {
  if (depth > 4 || error == null) return [];
  if (typeof error === "string") return [error];

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if (error.name) parts.push(error.name);
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "type", "errorMessage", "code", "reason"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
    if (typeof record.statusCode === "number") {
      parts.push(String(record.statusCode));
    }
    if (typeof record.responseBody === "string") {
      parts.push(record.responseBody);
      parts.push(...parseEmbeddedJsonStrings(record.responseBody, depth));
    }
    // pi-ai flattens the whole response into `message` as `429 {…}`, so the
    // explanation is reachable only by parsing from the first brace. Without
    // this the sole quotable candidate is the serialized blob.
    if (typeof record.message === "string") {
      parts.push(...parseEmbeddedJsonStrings(record.message, depth));
    }
    if (typeof record.error === "object" && record.error !== null) {
      parts.push(...collectErrorStrings(record.error, depth + 1));
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        parts.push(...collectErrorStrings(nested, depth + 1));
      }
    }
    if (record.lastError !== undefined) {
      parts.push(...collectErrorStrings(record.lastError, depth + 1));
    }
  }

  return parts;
}

export function isProviderRateLimitError(error: unknown): boolean {
  const haystack = collectErrorStrings(error).join(" ").toLowerCase();
  return (
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("rate limited") ||
    haystack.includes("429") ||
    haystack.includes("too many requests")
  );
}

export function isProviderOverloadError(error: unknown): boolean {
  const haystack = collectErrorStrings(error).join(" ").toLowerCase();
  return (
    haystack.includes("overloaded") ||
    haystack.includes("overloaded_error") ||
    haystack.includes("529")
  );
}

/**
 * Phrases that mean the account is out of allowance, as opposed to going too
 * fast. Anthropic returns both as HTTP 429 with `type: "rate_limit_error"`, so
 * the status code cannot tell them apart — only the sentence can.
 */
const QUOTA_SIGNALS: ReadonlyArray<{ pattern: RegExp; remedy: QuotaRemedy }> = [
  { pattern: /specified\s+api\s+usage\s+limits?/i, remedy: "api_spend_cap" },
  { pattern: /will\s+regain\s+access\s+on/i, remedy: "api_spend_cap" },
  {
    pattern: /monthly\s+(?:spend|budget|usage)\s+limit/i,
    remedy: "api_spend_cap",
  },
  { pattern: /credit\s+balance\s+is\s+too\s+low/i, remedy: "api_credits" },
  { pattern: /insufficient\s+credits?/i, remedy: "api_credits" },
  { pattern: /out\s+of\s+credits?/i, remedy: "api_credits" },
  { pattern: /usage\s+limit\s+reached/i, remedy: "subscription_quota" },
  {
    pattern: /exceeded\s+your\s+account'?s?\s+usage\s+limit/i,
    remedy: "subscription_quota",
  },
  {
    pattern: /(?:weekly|plan|quota)\s+limit\s+reached/i,
    remedy: "subscription_quota",
  },
];

/**
 * Markers of an ordinary burst ceiling. These take precedence, because the cost
 * of the two mistakes is not symmetric: calling a burst limit "spent allowance"
 * removes a retry that genuinely works, while the reverse merely wastes three
 * attempts before saying something useful.
 */
const TRANSIENT_SIGNALS: ReadonlyArray<RegExp> = [
  /per[-\s]?minute/i,
  /per[-\s]?second/i,
  // Anthropic's organization ceiling (ITPM/OTPM/RPM). Matched explicitly rather
  // than left to fall through, because it sits one word from the subscription
  // signal below — "your account's *rate* limit" against "your account's
  // *usage* limit" — and only a listed transient signal is safe from a quota
  // pattern that is later loosened by that one word.
  /exceeds?\s+your\s+account'?s?\s+rate\s+limit/i,
  /tokens?\s+per\s+(?:minute|second|hour|day)/i,
  /requests?\s+per\s+(?:minute|second|hour|day)/i,
  /concurrent/i,
];

function parseQuotaResetsAt(haystack: string): Date | undefined {
  // Claude subscription limits arrive as `usage limit reached|<epoch>`.
  const piped = haystack.match(
    /usage\s+limit\s+reached\s*\|\s*(\d{9,13})/i,
  );
  if (piped) {
    const raw = Number(piped[1]);
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Anchored to a reset word on purpose. An unanchored date scan would happily
  // report an unrelated timestamp elsewhere in the payload as the reset time,
  // and a confidently wrong date is worse than none.
  const anchored = haystack.match(
    /(?:resets?|regain\s+access(?:\s+on)?|available\s+again)\D{0,20}(\d{4}-\d{2}-\d{2})(?:T|\s+at\s+|\s+)?(\d{1,2}):(\d{2})?/i,
  );
  if (anchored) {
    const [, day, hour, minute] = anchored;
    const date = new Date(
      `${day}T${hour.padStart(2, "0")}:${minute ?? "00"}:00Z`,
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  const dateOnly = haystack.match(
    /(?:resets?|regain\s+access(?:\s+on)?|available\s+again)\D{0,20}(\d{4}-\d{2}-\d{2})/i,
  );
  if (dateOnly) {
    const date = new Date(`${dateOnly[1]}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return undefined;
}

/** Anything holding a JSON object is a serialized body, not a sentence. */
const SERIALIZED_BODY = /[{[]\s*["{[]/;

/**
 * Pull the strings out of a JSON body embedded in a larger string.
 *
 * pi-ai reports `429 {"type":"error",…}`, so the sentence worth quoting is only
 * reachable by parsing from the first brace onwards.
 */
function parseEmbeddedJsonStrings(raw: string, depth: number): string[] {
  const start = raw.search(/[{[]/);
  if (start < 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start));
    if (typeof parsed !== "object" || parsed === null) return [];
    return collectErrorStrings(parsed, depth + 1);
  } catch {
    return [];
  }
}

/**
 * The longest sentence the provider gave us, which is usually the useful one.
 *
 * Serialized bodies are demoted rather than dropped: they are noise beside the
 * message they contain, but they are better than quoting nothing at all when
 * a provider hands us no prose.
 */
function extractProviderSentence(error: unknown): string | undefined {
  const candidates = collectErrorStrings(error)
    .map((part) => part.trim())
    .filter((part) => part.length > 24 && /[a-z]{4}/i.test(part))
    .sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return undefined;
  return (
    candidates.find((part) => !SERIALIZED_BODY.test(part)) ?? candidates[0]
  );
}

/**
 * Classify a provider refusal as spent allowance, or not.
 *
 * Returns null for anything that waiting could plausibly fix, which keeps the
 * existing silent-retry path in charge of transient limits.
 */
export function detectProviderQuotaExhaustion(
  error: unknown,
): ProviderQuotaExhaustion | null {
  const haystack = collectErrorStrings(error).join(" ");
  if (!haystack.trim()) return null;

  if (TRANSIENT_SIGNALS.some((pattern) => pattern.test(haystack))) return null;

  const signal = QUOTA_SIGNALS.find(({ pattern }) => pattern.test(haystack));
  if (!signal) return null;

  return {
    remedy: signal.remedy,
    providerMessage: extractProviderSentence(error),
    resetsAt: parseQuotaResetsAt(haystack),
  };
}

function formatResetInstant(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

const REMEDY_COPY: Record<
  QuotaRemedy,
  {
    headline: string;
    /** The same fact with the credential named, for when the token told us. */
    attributed: (credential: string) => string;
    action: string;
  }
> = {
  subscription_quota: {
    headline: "Your subscription's usage limit is reached",
    attributed: (credential) => `${credential} has reached its usage limit`,
    action:
      "Switch to a model that still has quota, or use an API key instead — Settings → AI Models.",
  },
  api_spend_cap: {
    headline: "Your API spend limit is reached",
    attributed: (credential) => `${credential} has reached its spend limit`,
    action:
      "Raise or remove the cap in your provider's console, or switch to a subscription login — Settings → AI Models.",
  },
  api_credits: {
    headline: "Your API credit balance is empty",
    attributed: (credential) => `${credential} has no credit left`,
    action:
      "Add credits in your provider's billing settings, or switch to a subscription login — Settings → AI Models.",
  },
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeQuotaExhaustion(
  detail: ProviderQuotaExhaustion,
  credential?: CredentialDescriptor,
): string {
  const { headline, attributed, action } = REMEDY_COPY[detail.remedy];

  // Naming the reset up front is the whole point: it is what tells the user
  // whether to wait or to go change a setting.
  const timing = detail.resetsAt
    ? ` Access returns ${formatResetInstant(detail.resetsAt)}.`
    : "";

  // Which credential this was spent on. Both can be exhausted at once for
  // unrelated reasons, so an unattributed limit leaves the user unable to tell
  // whether switching between them changed anything.
  const inUse = describeCredentialInUse(credential);
  const subject = inUse ? sentenceCase(attributed(inUse)) : headline;

  const lines = [
    `${subject} — retrying won't help until it resets.${timing}`,
    action,
  ];
  if (detail.providerMessage) {
    lines.push(`Provider said: “${detail.providerMessage}”`);
  }
  return lines.join("\n\n");
}

export function isRetryableProviderCapacityError(error: unknown): boolean {
  // Spent allowance is not capacity pressure. Retrying it burns three attempts
  // and a backoff to arrive at the same refusal, then offers Resume for a limit
  // that may be weeks from clearing.
  if (detectProviderQuotaExhaustion(error)) return false;
  return isProviderRateLimitError(error) || isProviderOverloadError(error);
}

function parseRetryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  const direct = record.retryAfter ?? record["retry-after"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim()) {
    const parsed = Number.parseFloat(direct);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const headers = record.headers;
  if (typeof headers === "object" && headers !== null) {
    const headerRecord = headers as Record<string, unknown>;
    const headerValue =
      headerRecord["retry-after"] ?? headerRecord["Retry-After"];
    if (typeof headerValue === "string" && headerValue.trim()) {
      const parsed = Number.parseFloat(headerValue);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }

  if (typeof record.responseBody === "string") {
    try {
      const body = JSON.parse(record.responseBody) as Record<string, unknown>;
      const retryAfter = body.retry_after ?? body.retryAfter;
      if (typeof retryAfter === "number" && retryAfter >= 0) return retryAfter;
    } catch {
      // ignore malformed JSON
    }
  }

  return undefined;
}

export function computeRateLimitBackoffMs(
  attempt: number,
  error?: unknown,
): number {
  const retryAfterSec = error ? parseRetryAfterSeconds(error) : undefined;
  if (retryAfterSec != null) {
    return Math.min(Math.max(Math.ceil(retryAfterSec * 1000), 500), 120_000);
  }

  const exponential = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * exponential * 0.25);
  return exponential + jitter;
}


export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
