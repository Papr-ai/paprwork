/**
 * Classify writer op failures for outbox retry vs dead-letter.
 */

import { AppOpsClientError, AppOpsConflictError } from "./AppOpsClient.js";

export function isWriterConflictError(error: unknown): error is AppOpsConflictError {
  return error instanceof AppOpsConflictError;
}

/**
 * Transient 4xx: 408 (our own writer-request timeout) and 429 (Cloud Run
 * "Rate exceeded" when every writer instance is busy, or GitHub rate limit).
 * These clear on their own, so they must retry rather than dead-letter.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

/** Non-retryable client errors (abuse filter, bad payload) — dead-letter immediately. */
export function isPermanentWriterClientError(error: unknown): boolean {
  if (isWriterConflictError(error)) {
    return true;
  }
  if (error instanceof AppOpsClientError) {
    if (RETRYABLE_CLIENT_STATUSES.has(error.status)) {
      return false;
    }
    return error.status >= 400 && error.status < 500;
  }
  return false;
}

export function writerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
