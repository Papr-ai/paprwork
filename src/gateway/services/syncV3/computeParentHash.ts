/**
 * Compute git blob OID for file contents (Sync V3 parentHash).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

async function hashObjectViaGit(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["hash-object", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const oid = stdout.trim();
      resolve(oid.length > 0 ? oid : null);
    });
  });
}

/** Pure-JS fallback when git CLI unavailable (tests / sandbox). */
export function hashBlobContent(content: string): string {
  const header = Buffer.from(`blob ${Buffer.byteLength(content, "utf8")}\0`);
  const body = Buffer.from(content, "utf8");
  return createHash("sha1").update(header).update(body).digest("hex");
}

/** Blob OID for on-disk file — prefers `git hash-object`. */
export async function computeBlobOidForFile(filePath: string): Promise<string> {
  const viaGit = await hashObjectViaGit(filePath);
  if (viaGit) {
    return viaGit;
  }
  const content = await fs.readFile(filePath, "utf8");
  return hashBlobContent(content);
}

/** Blob OID for in-memory content. */
export async function computeBlobOidForContent(content: string): Promise<string> {
  return hashBlobContent(content);
}
