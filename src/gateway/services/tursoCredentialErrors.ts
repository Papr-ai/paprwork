/**
 * Classify Turso credential fetch failures for job validation and logging.
 * Distinguishes ACL / wrong-user segment from rate limits and corrupt local files.
 */

export type TursoCredentialFailureKind =
  | "access_denied"
  | "rate_limit"
  | "missing_api_key"
  | "unknown";

export function classifyTursoCredentialFailure(
  message: string,
): TursoCredentialFailureKind {
  const lower = message.toLowerCase();

  if (
    lower.includes("papr_api_key not configured") ||
    lower.includes("no papr api key")
  ) {
    return "missing_api_key";
  }

  if (
    lower.includes("install db-token failed (403)") ||
    lower.includes("install db-token failed (401)") ||
    lower.includes("no read access") ||
    lower.includes("not authorized") ||
    lower.includes("permission denied") ||
    lower.includes("validate_access") ||
    lower.includes("does not have access")
  ) {
    return "access_denied";
  }

  if (
    lower.includes("maximum database count") ||
    lower.includes("database limit reached") ||
    lower.includes("blocked from creating") ||
    lower.includes("enable overages") ||
    lower.includes("turso database limit") ||
    (lower.includes("turso token request failed (429)"))
  ) {
    return "rate_limit";
  }

  // Nested Turso 403 inside memory 500 — provisioning overload, not ACL.
  if (
    lower.includes("database provisioning failed") &&
    lower.includes("403 forbidden")
  ) {
    return "rate_limit";
  }

  if (
    lower.includes("turso token request failed (403)") &&
    !lower.includes("install db-token")
  ) {
    return "access_denied";
  }

  return "unknown";
}
