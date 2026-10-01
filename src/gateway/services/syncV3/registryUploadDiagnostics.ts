/**
 * Remembers WHY the last namespace databases-registry upload failed so the
 * publish warning can show the server's reason instead of a generic message.
 * Kept in its own module so callers can read it without importing the client.
 */

let lastRegistryUploadError: string | null = null;

export function setLastRegistryUploadError(message: string | null): void {
  lastRegistryUploadError = message ? message.slice(0, 300) : null;
}

/** " (reason)" suffix for error text, or "" when no reason is known. */
export function registryUploadErrorDetail(): string {
  return lastRegistryUploadError ? ` (${lastRegistryUploadError})` : "";
}

/** Test-only */
export function resetRegistryUploadDiagnosticsForTests(): void {
  lastRegistryUploadError = null;
}
