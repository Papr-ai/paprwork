/**
 * User- and agent-facing messages when replica schema heal / Turso primary fallback fails.
 */

import { isReplicaSqlSchemaError } from "./tursoReplicaCheckpointRecovery.js";

const DETAIL_MAX = 280;

export function isReplicaSchemaMismatchUserError(message: string): boolean {
  return message.startsWith("Schema mismatch for ");
}

/** HTTP status for mini-app `/api/db/query` failures (500 = fix SQL/migrations, not retry). */
export function httpStatusForMiniAppDbQueryError(message: string): 500 | 503 {
  if (isReplicaSchemaMismatchUserError(message)) {
    return 500;
  }
  const lowerMessage = message.toLowerCase();
  if (
    message.includes("Turso fallback is unavailable") ||
    message.includes("Local database not found") ||
    message.includes("No data sources linked") ||
    message.includes("Replica read timed out") ||
    message.includes("Gateway was busy") ||
    message.includes("Database sync in progress") ||
    message.includes("Schema update pending") ||
    lowerMessage.includes("no such table") ||
    lowerMessage.includes("sync engine operation failed")
  ) {
    return 503;
  }
  return 500;
}

function truncateDetail(text: string, max = DETAIL_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function pickSchemaSqlDetail(
  localMessage: string,
  healMessage: string | undefined,
  primaryMessage: string | undefined,
): string {
  for (const candidate of [primaryMessage, healMessage, localMessage]) {
    if (candidate && isReplicaSqlSchemaError(candidate)) {
      return truncateDetail(candidate);
    }
  }
  return truncateDetail(healMessage ?? localMessage);
}

export function buildReplicaSchemaDriftFailureError(options: {
  sourceLabel: string;
  localMessage: string;
  healMessage?: string;
  primaryMessage?: string;
  primaryUnavailable?: boolean;
}): Error {
  const label = options.sourceLabel.trim() || "database";
  const primary = options.primaryMessage?.trim();

  if (primary && isReplicaSqlSchemaError(primary)) {
    const detail = pickSchemaSqlDetail(
      options.localMessage,
      options.healMessage,
      primary,
    );
    return new Error(
      `Schema mismatch for ${label}: ${detail} ` +
        "Turso primary reports the same SQL/schema error, so this is not replica catch-up. " +
        "Fix the app query or add and apply a migration under this database's migrations/ folder " +
        "(papr_db_apply_migration / papr_db_migration_parity — do not write _papr_schema_migrations via /api/db/write).",
    );
  }

  const localDetail = pickSchemaSqlDetail(
    options.localMessage,
    options.healMessage,
    undefined,
  );

  if (options.primaryUnavailable) {
    return new Error(
      `Schema update pending for ${label}. Local replica is catching up — retry in a moment. ` +
        `Original: ${localDetail}. Turso primary was unavailable for verification.`,
    );
  }

  if (primary) {
    return new Error(
      `Schema update pending for ${label}. Local replica is catching up — retry in a moment. ` +
        `Local: ${localDetail}. Turso primary: ${truncateDetail(primary)}.`,
    );
  }

  return new Error(
    `Schema update pending for ${label}. Local replica is catching up — retry in a moment. ` +
      `Original: ${localDetail}.`,
  );
}
