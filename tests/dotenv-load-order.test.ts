/**
 * Issue 103 — every process entry point must load `.env` as well as `.env.local`.
 *
 * `PAPR_TURSO_REPLICA_SYNC` lives in `.env`. No entry point loaded that file,
 * so dev builds ran with the replica engine off and the legacy engine adopted
 * databases the registry had already assigned to the replica engine. The
 * variable was not missing — it was unread.
 *
 * Scanned rather than listed, so an entry point added later is covered
 * without anyone remembering this rule.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function dotenvCallSites(): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = [];
  const entries = readdirSync(SRC, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|cjs|mjs|js)$/.test(entry.name)) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    const source = readFileSync(file, "utf8");
    // A dotenv *call*, not a mention: several modules read env vars by name
    // without loading any file, and those are not entry points.
    if (!/dotenv["')]?\s*\)?\s*\.config\(|dotenv\.config\(/.test(source)) {
      continue;
    }
    found.push({ file: file.slice(SRC.length + 1), source });
  }
  return found;
}

describe("dotenv load order at process entry points", () => {
  const sites = dotenvCallSites();

  it("finds the known entry points", () => {
    // Guard the guard: a scan that matches nothing would pass every
    // assertion below without checking anything.
    const files = sites.map((site) => site.file);
    expect(files).toContain("electron/index.cjs");
    expect(files).toContain("gateway/index.ts");
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(sites.map((site) => [site.file, site.source] as const))(
    "%s loads .env beneath .env.local",
    (_file, source) => {
      // Matched on the trailing quote so `.env"` cannot also match inside
      // `.env.local"`. Paths differ between entry points (`.env.local` vs
      // `../../.env.local`), so the prefix is not part of the pattern.
      const localAt = source.search(/\.env\.local"/);
      const envAt = source.search(/\.env"/);

      expect(localAt, "must load .env.local").toBeGreaterThan(-1);
      expect(envAt, "must load .env").toBeGreaterThan(-1);

      // dotenv never overwrites an already-set variable, so the first file to
      // define a key wins. `.env.local` must therefore be read first for it
      // to keep taking precedence over `.env`.
      expect(localAt).toBeLessThan(envAt);
    },
  );
});
