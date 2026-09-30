/**
 * Sync V3 capability reporting — always-on in this build (no env rollout flags).
 */

import type { SyncProtocolVersion, SyncV3FlagName } from "../../../core/types/syncV3.js";

/** Capabilities this desktop build implements (reported on heartbeat). */
const IMPLEMENTED_CAPABILITIES: readonly SyncV3FlagName[] = [
  "SYNC_V3_PER_APP_REPOS",
  "SYNC_V3_WRITER_OPS",
  "SYNC_V3_LOG_ROWS",
  "SYNC_V3_SCHEMA_LOG",
  "SYNC_V3_DISPATCH_PUSH",
] as const;

export function isSyncV3FlagEnabled(name: SyncV3FlagName): boolean {
  return (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(name);
}

/** Schema migrations via workspace log (always on; memory applies DDL on append). */
export function isSyncV3SchemaLogEnabled(): boolean {
  return true;
}

export function getEnabledSyncV3Capabilities(): SyncV3FlagName[] {
  return IMPLEMENTED_CAPABILITIES.filter((cap) => isSyncV3FlagEnabled(cap));
}

export function getDesktopSyncProtocol(): SyncProtocolVersion {
  return "v3";
}
