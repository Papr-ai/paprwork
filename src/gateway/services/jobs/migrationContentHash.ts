/**
 * SHA-256 contentHash for migration log payloads.
 * Must match memory `schema_migration_executor.verify_migration_content_hash`.
 */

import { createHash } from "crypto";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";

/** Match Python json.dumps(..., separators=(",", ":"), sort_keys=True). */
function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeSchemaPayloadContentHash(payload: {
  migrationId: string;
  ops?: JobMigrationSchemaOp[] | null;
  statements?: string[] | null;
}): string {
  const canonical = canonicalJsonStringify({
    migrationId: payload.migrationId,
    ops: payload.ops ?? null,
    statements: payload.statements ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** @deprecated Prefer computeSchemaPayloadContentHash from built payload fields. */
export async function computeMigrationContentHash(
  _migrationRoot: string,
  migrationId: string,
  fallback?: { ops?: JobMigrationSchemaOp[]; statements?: string[] },
): Promise<string> {
  return computeSchemaPayloadContentHash({
    migrationId,
    ops: fallback?.ops ?? null,
    statements: fallback?.statements ?? null,
  });
}
