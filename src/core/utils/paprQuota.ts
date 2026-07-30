/**
 * Papr Memory quota / plan-limit detection and user-facing copy.
 * Used by gateway services, tools, and the renderer quota banner.
 */

export const PAPR_USAGE_URL = "https://dashboard.papr.ai/usage";

export type PaprQuotaKind =
  | "operations"
  | "memories"
  | "storage"
  | "rate_limit"
  | "unknown";

export type PaprQuotaSeverity = "warning" | "exceeded";

export interface PaprQuotaStatus {
  kind: PaprQuotaKind;
  severity: PaprQuotaSeverity;
  title: string;
  detail: string;
  suggestMeteredBilling: boolean;
  billingUrl: string;
  source?: string;
}

type QuotaListener = (status: PaprQuotaStatus) => void;

let quotaExceededListener: QuotaListener | null = null;

/** Gateway registers this at startup to broadcast quota events to the UI. */
export function setPaprQuotaExceededListener(listener: QuotaListener | null): void {
  quotaExceededListener = listener;
}

export function notifyPaprQuotaStatus(status: PaprQuotaStatus): void {
  quotaExceededListener?.(status);
}

const QUOTA_SIGNAL_PATTERNS = [
  /interaction limit/i,
  /limit reached/i,
  /quota exceeded/i,
  /memory limit/i,
  /storage limit/i,
  /upgrade your plan/i,
  /enable metered billing/i,
  /manage your subscription/i,
  /dashboard\.papr\.ai/i,
  /operations limit/i,
  /memories limit/i,
];

const NON_QUOTA_403_PATTERNS = [
  /namespace/i,
  /not authorized/i,
  /access denied/i,
  /invalid api key/i,
  /authentication/i,
];

function extractNestedMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const body = record.body;
  if (body && typeof body === "object") {
    const bodyRecord = body as Record<string, unknown>;
    if (typeof bodyRecord.message === "string" && bodyRecord.message.trim()) {
      return bodyRecord.message;
    }
    if (typeof bodyRecord.error === "string" && bodyRecord.error.trim()) {
      return bodyRecord.error;
    }
  }
  for (const key of ["message", "error", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    return extractNestedMessage(error) ?? error.message;
  }
  if (error && typeof error === "object") {
    const nested = extractNestedMessage(error);
    if (nested) return nested;
  }
  return String(error ?? "");
}

function isLikelyQuotaMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  if (NON_QUOTA_403_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return QUOTA_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
  }
  return QUOTA_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isPaprQuotaError(error: unknown): boolean {
  if (!error) return false;

  const message = extractErrorMessage(error);
  if (isLikelyQuotaMessage(message)) return true;

  if (error && typeof error === "object") {
    const name = (error as { name?: string }).name;
    const status = (error as { status?: number }).status;
    if (
      (name === "PermissionDeniedError" || name === "RateLimitError") &&
      (status === 403 || status === 429)
    ) {
      return isLikelyQuotaMessage(message) || /upgrade|limit|quota|metered/i.test(message);
    }
  }

  return false;
}

function defaultDetail(kind: PaprQuotaKind): string {
  switch (kind) {
    case "memories":
      return "You've reached your plan's memory count limit.";
    case "storage":
      return "You've reached your plan's storage limit.";
    case "operations":
      return "You've used your monthly Papr Memory operations allowance.";
    case "rate_limit":
      return "Papr Memory is rate-limiting requests on your account.";
    default:
      return "Your Papr Memory plan limit has been reached.";
  }
}

function titleForKind(kind: PaprQuotaKind): string {
  switch (kind) {
    case "memories":
      return "Memory limit reached";
    case "storage":
      return "Storage limit reached";
    case "operations":
      return "Operations limit reached";
    case "rate_limit":
      return "Papr Memory rate limited";
    default:
      return "Papr Memory limit reached";
  }
}

function classifyKind(message: string): PaprQuotaKind {
  if (/storage/i.test(message)) return "storage";
  if (/memory count|memories limit|memory limit|active memories/i.test(message)) {
    return "memories";
  }
  if (/interaction|operations limit|operation cost|mini interactions/i.test(message)) {
    return "operations";
  }
  if (/rate limit|too many requests|429/i.test(message)) return "rate_limit";
  return "unknown";
}

export function parsePaprQuotaError(
  error: unknown,
  source?: string,
): PaprQuotaStatus | null {
  if (!isPaprQuotaError(error)) return null;

  const rawMessage = extractErrorMessage(error).trim();
  const kind = classifyKind(rawMessage);
  const suggestMeteredBilling =
    /metered billing/i.test(rawMessage) ||
    kind === "operations" ||
    kind === "unknown";

  const detail =
    rawMessage.length > 0 && rawMessage.length < 500
      ? rawMessage
      : `${defaultDetail(kind)} Open Papr to upgrade or enable metered billing.`;

  return {
    kind,
    severity: "exceeded",
    title: titleForKind(kind),
    detail,
    suggestMeteredBilling,
    billingUrl: PAPR_USAGE_URL,
    source,
  };
}

export function formatPaprQuotaMessage(status: PaprQuotaStatus): string {
  return `${status.title} ${status.detail}`;
}

export function reportPaprQuotaError(
  error: unknown,
  source: string,
): PaprQuotaStatus | null {
  const status = parsePaprQuotaError(error, source);
  if (!status) return null;
  notifyPaprQuotaStatus(status);
  return status;
}
