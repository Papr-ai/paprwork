import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App backends (backendDbHelper.py) and jobs (job-sdk/papr_db.py) reach the
 * database through the gateway, which returns JSON rows. Handlers and jobs are
 * written with sqlite3 idioms, so both helpers return the shared
 * papr_sqlite_compat Row/Cursor. This runs each idiom against real sqlite3 and
 * through all three paths (backend proxy, backend Turso, job replica) and
 * requires identical results. A new gap fails here, not in a user's app.
 */
describe("sqlite3 parity: backend helper + job SDK", () => {
  it("every sqlite3 idiom returns what real sqlite3 returns", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "papr-sqlite-parity-"));
    try {
      copyFileSync(
        path.resolve("src/gateway/services/appRuntime/backendDbHelper.py"),
        path.join(dir, "papr_db.py"),
      );
      const out = execFileSync(
        "python3",
        [
          path.resolve("tests/fixtures/backend-db/sqlite_parity_check.py"),
          dir,
          path.resolve("src/resources/job-sdk"),
        ],
        { encoding: "utf8" },
      );
      expect(out).toContain("parity ok");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`sqlite3 parity failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
