import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runs the real backendDbHelper.py (shipped to handlers as papr_db.py) against
 * in-memory SQLite: owner / shared / public / legacy-NULL rows, anonymous caller,
 * write filter, and a malformed caller id that must not reach SQL.
 */
describe("backendDbHelper.py row _acl helpers", () => {
  it("filters reads and writes by the verified caller", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "papr-acl-"));
    try {
      copyFileSync(
        path.resolve("src/gateway/services/appRuntime/backendDbHelper.py"),
        path.join(dir, "papr_db.py"),
      );
      const out = execFileSync(
        "python3",
        [path.resolve("tests/fixtures/acl/acl_helper_check.py"), dir],
        { encoding: "utf8", env: { ...process.env, PAPR_CALLER_USER_ID: "" } },
      );
      expect(out).toContain("python acl ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
