/**
 * Classify writer op failures for outbox retry vs dead-letter.
 */

import { AppOpsClientError, AppOpsConflictError } from "./AppOpsClient.js";

export function isWriterConflictError(error: unknown): error is AppOpsConflictError {
  return error instanceof AppOpsConflictError;
}

/** Non-retryable client errors (abuse filter, bad payload) — dead-letter immediately. */
export function isPermanentWriterClientError(error: unknown): boolean {
  if (isWriterConflictError(error)) {
    return true;
  }
  if (error instanceof AppOpsClientError) {
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
