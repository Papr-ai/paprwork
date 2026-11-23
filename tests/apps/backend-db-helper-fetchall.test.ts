import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Agent-written backends use the sqlite3 idiom `con.execute(sql).fetchall()`.
 * The proxy/Turso connections returned a bare list, so every such handler
 * crashed with AttributeError (grocery-list showed an empty list).
 */
describe("backendDbHelper.py sqlite3-style execute()", () => {
  it("supports fetchall/fetchone/rowcount on proxy and Turso connections", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "papr-fetchall-"));
    try {
      copyFileSync(
        path.resolve("src/gateway/services/appRuntime/backendDbHelper.py"),
        path.join(dir, "papr_db.py"),
      );
      const out = execFileSync(
        "python3",
        [path.resolve("tests/fixtures/backend-db/fetchall_check.py"), dir],
        { encoding: "utf8" },
      );
      expect(out).toContain("fetchall ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
