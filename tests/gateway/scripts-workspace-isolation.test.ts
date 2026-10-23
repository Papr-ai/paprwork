/**
 * Every script under scripts/ that test-runs app code must say which workspace
 * it uses: a temp one (./lib/isolateHome.mjs) or, deliberately, the real one
 * (./lib/requireRealWorkspace.mjs, gated on PAPR_E2E_REAL_HOME=1).
 *
 * Without this, test-jobs-e2e and test-jobs-advanced created jobs in a live
 * ~/Papr workspace and their scheduler marked the user's running jobs stale
 * (2026-10-22). Setting PAPR_HOME alone does not help: the real
 * ~/Papr/.active-workspace.json pointer overrides it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const APP_CODE = /["']\.\.\/(dist|src)\/(gateway|core)\//;
const GUARD = /^import ["']\.\/lib\/(isolateHome|requireRealWorkspace)\.mjs["'];/m;
const TEST_SCRIPT = /^(test-|e2e-).+\.(mjs|ts|cjs)$/;

function testScripts(): string[] {
  return readdirSync(SCRIPTS).filter((f) => TEST_SCRIPT.test(f));
}

describe("scripts workspace isolation", () => {
  it("every test script that loads app code declares its workspace", () => {
    const missing = testScripts().filter((f) => {
      const src = readFileSync(path.join(SCRIPTS, f), "utf8");
      return APP_CODE.test(src) && !GUARD.test(src);
    });
    expect(missing, "import ./lib/isolateHome.mjs (or requireRealWorkspace.mjs) first").toEqual([]);
  });

  it("the guard import comes before any app-code import", () => {
    const late = testScripts().filter((f) => {
      const src = readFileSync(path.join(SCRIPTS, f), "utf8");
      const guard = src.search(GUARD);
      const firstStatic = src.search(/^import .*["']\.\.\/(dist|src)\//m);
      return guard >= 0 && firstStatic >= 0 && firstStatic < guard;
    });
    expect(late).toEqual([]);
  });
});
