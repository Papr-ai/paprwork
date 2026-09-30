/**
 * Architectural invariant: the gateway process never loads `@tursodatabase/sync`.
 *
 * The native sync engine can abort() the hosting process on a Rust panic. Only the sync
 * worker child (tursoReplicaSyncWorkerEntry → tursoReplicaConnect) may import it at
 * runtime. Every other module must go through TursoReplicaSyncWorkerClient. Type-only
 * imports are fine — they are erased.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../src");
const ALLOWED = new Set([
  "gateway/services/tursoReplica/tursoReplicaConnect.ts",
  "gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.ts",
  "gateway/services/tursoReplica/tursoReplicaSyncWorkerEntry.ts",
]);

const RUNTIME_IMPORT =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["']@tursodatabase\/sync["']|require\(\s*["']@tursodatabase\/sync["']\s*\)|import\(\s*["']@tursodatabase\/sync["']\s*\)/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("@tursodatabase/sync import guard", () => {
  it("is only imported at runtime by the sync worker", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (RUNTIME_IMPORT.test(source)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "These files load the native Turso sync engine in-process. Route through " +
        "TursoReplicaSyncWorkerClient instead — a Rust panic there kills the gateway.",
    ).toEqual([]);
  });

  it("worker core is the only importer of tursoReplicaConnect", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*tursoReplicaConnect\.js["']/.test(source)) {
        // type-only re-exports are fine
        if (/import\s+type\b[^;]*tursoReplicaConnect\.js/.test(source)) continue;
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
