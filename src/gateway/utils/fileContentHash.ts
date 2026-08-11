import { createHash } from "node:crypto";

/** SHA-256 hex digest of UTF-8 file content (track sync snapshots). */
export function fileContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
