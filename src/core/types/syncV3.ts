/**
 * Sync V3 protocol types — capability handshake, flags, heartbeat payload.
 * @see docs/SYNC_ARCHITECTURE_V3.md
 * @see docs/SYNC_V3_IMPLEMENTATION_PLAN.md
 */

/** Desktop ↔ memory server sync capability version. */
export type SyncProtocolVersion = "v2" | "v3";

/** Sync V3 capability names (reported on heartbeat; always on in current build). */
export type SyncV3FlagName =
  | "SYNC_V3_PER_APP_REPOS"
  | "SYNC_V3_WRITER_OPS"
  | "SYNC_V3_LOG_ROWS"
  | "SYNC_V3_SCHEMA_LOG"
  | "SYNC_V3_DISPATCH_PUSH"
  | "SYNC_V3_RELEASES";

/** Implemented capabilities in this build (no env rollout). */
export const SYNC_V3_IMPLEMENTED_CAPABILITIES: readonly SyncV3FlagName[] = [
  "SYNC_V3_PER_APP_REPOS",
  "SYNC_V3_WRITER_OPS",
  "SYNC_V3_LOG_ROWS",
  "SYNC_V3_DISPATCH_PUSH",
] as const;

/** Body fields sent with POST /v1/cloud/runtime/heartbeat from desktop gateway. */
export interface DesktopHeartbeatRequest {
  syncProtocol: SyncProtocolVersion;
  /** Gateway semver — memory server tracks desktop versions. */
  appVersion?: string;
  namespaceId?: string;
  /** Capabilities this client implements. */
  syncV3Capabilities?: SyncV3FlagName[];
}

/** V3 observability counters (also emitted via telemetry when enabled). */
export type SyncV3MetricName =
  | "namespace_git_push_count"
  | "v3_op_count"
  | "writer_conflict_count"
  | "oplog_append_latency_p99"
  | "scheduler_missed_fire_count";
