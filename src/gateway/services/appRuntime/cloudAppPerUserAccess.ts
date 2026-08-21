/**
 * Per-user Turso isolation — publish rules and runtime sign-in enforcement.
 */

import type { AppDataSourcesFile } from "../appDataSources.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";

/** True when any linked registry source uses per-user Turso isolation. */
export function configHasPerUserLinkedSources(config: AppDataSourcesFile): boolean {
  const registry = getDatabaseRegistryService();
  for (const source of config.sources) {
    const record = registry.getRecordForSource(source);
    if (record?.isolation === "per-user") {
      return true;
    }
  }
  return false;
}

/** Per-user DBs require Papr sign-in — coerce at publish time. */
export function coerceRequireSignInForPerUserIsolation(
  perUserIsolation: boolean | undefined,
  requireSignIn: boolean | undefined,
): boolean | undefined {
  if (perUserIsolation === true) {
    return true;
  }
  return requireSignIn;
}

export function perUserIsolationRequiresCallerSignIn(
  perUserIsolation: boolean | undefined,
  config?: AppDataSourcesFile,
): boolean {
  if (perUserIsolation === true) {
    return true;
  }
  if (config && configHasPerUserLinkedSources(config)) {
    return true;
  }
  return false;
}
