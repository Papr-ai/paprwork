/**
 * Point the Papr workspace at a temp directory before any test module loads.
 *
 * WHY A SETUP FILE AND NOT A HOOK
 * -------------------------------
 * `useIsolatedPaprWorkspace()` is the right tool when a suite needs its own
 * workspace per test, but it registers `beforeEach` hooks — and hooks run
 * *after* the test module has been imported. Several modules call
 * `getPaprRoot()` at import time (a module-level const, or a service
 * constructed on import), so by the time any hook could fire, the guard in
 * `paprRoot.ts` has already thrown and the whole file fails to collect. That
 * is why `mini-app-guards`, `papr-schema-tools` and `turso-write-batch` failed
 * with a collection error rather than a test failure: there was no hook that
 * could have run early enough.
 *
 * A setup file runs before the test module is imported, so it is the only
 * place that can answer those cases.
 *
 * WHAT THIS GIVES US
 * ------------------
 * A safe *default*, not a replacement for the per-test helper. Any suite that
 * needs isolation between individual tests should still call
 * `useIsolatedPaprWorkspace()`; it saves and restores these same variables in
 * its own hooks, so the two compose without conflict.
 *
 * The important property is that the default is now safe. Before this, a new
 * test that touched the workspace resolved to the developer's real `~/Papr`
 * unless its author remembered the helper, and forgetting it once is what
 * leaked ~305 fixture apps and 462 job folders into a live workspace on
 * 2026-08-12. Opting *in* to safety is the wrong default for something that
 * destructive.
 *
 * WHY IT MOVES `HOME` AND *CLEARS* `PAPR_HOME`
 * --------------------------------------------
 * On POSIX `os.homedir()` reads `$HOME`, so moving `HOME` relocates both
 * `getPaprBaseDir()` and the `.active-workspace.json` pointer lookup. That
 * last part matters locally, where the pointer exists and outranks
 * `PAPR_HOME`; without it a developer's real pointer would win and the guard
 * would still fire.
 *
 * `PAPR_HOME` is *deleted* rather than set, which is the opposite of what the
 * per-test helper does, and deliberately so. `getPaprRoot()` consults
 * `PAPR_HOME` before falling back to `getPaprBaseDir()`, so setting it here
 * would outrank a suite that patches only `HOME` — the suite would appear to
 * set up its own workspace while every read went somewhere else. That is how
 * `db-path-normalization` broke on the first attempt at this file. Leaving
 * `HOME` as the single lever keeps the resolution order that existing suites
 * already rely on, and clearing the variable also protects the case where a
 * developer has a real `PAPR_HOME` exported in their shell.
 *
 * `PAPR_USER_DATA` is cleared for the same reason: it would override a suite
 * that expects `~/.paprwork-v2` to follow `HOME`.
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Respect the existing escape hatch: a suite that genuinely means to touch a
// real workspace sets this, and it should keep working.
if (process.env.PAPR_ALLOW_REAL_WORKSPACE_IN_TESTS !== "1") {
  // Per-worker, so parallel workers never share a workspace, and stable within
  // a worker so a suite's beforeAll and its tests agree on the same root.
  const homeDir = path.join(
    os.tmpdir(),
    `papr-vitest-${process.pid}-${randomUUID()}`,
  );
  mkdirSync(path.join(homeDir, "Papr"), { recursive: true });
  mkdirSync(path.join(homeDir, ".paprwork-v2"), { recursive: true });

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir; // Windows
  delete process.env.PAPR_HOME;
  delete process.env.PAPR_USER_DATA;

  process.on("exit", () => {
    try {
      rmSync(homeDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort — the OS will reap tmpdir anyway */
    }
  });
}
