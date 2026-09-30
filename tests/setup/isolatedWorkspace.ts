/**
 * Isolated Papr workspace for tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * getPaprRoot() resolves in this order:
 *   1. ensureActiveWorkspaceEnvSynced() reads ~/Papr/.active-workspace.json
 *   2. if that pointer exists, it WINS — and it even overwrites process.env.PAPR_HOME
 *   3. only if there is no pointer does PAPR_HOME / getPaprBaseDir() apply
 *
 * getPaprBaseDir() is path.join(os.homedir(), "Papr"), so patching `os.homedir`
 * or HOME alone is NOT enough: the pointer is read from the developer's REAL
 * home and every createApp()/createJob() lands in their live workspace.
 *
 * That is exactly what happened on 2026-08-12 — a CI/local run leaked ~305
 * fixture apps ("Subdir App_7", "Backend App_12", …) and 462 job folders into
 * a real user workspace.
 *
 * This helper neutralises all three resolution paths at once by pointing HOME,
 * PAPR_HOME and the pointer file itself at a temp dir.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { afterEach, beforeEach } from "vitest";

export interface IsolatedWorkspace {
  /** Fake HOME root for this test. */
  readonly homeDir: string;
  /** Resolved PAPR_HOME — the workspace under the fake home. */
  readonly paprHome: string;
}

/**
 * Registers beforeEach/afterEach hooks that redirect the entire Papr workspace
 * to a per-test temp directory. Call at the top level of a describe block.
 *
 * Returns a live handle whose fields are populated before each test.
 */
export function useIsolatedPaprWorkspace(
  label = "papr-test",
): IsolatedWorkspace {
  const handle = { homeDir: "", paprHome: "" } as {
    homeDir: string;
    paprHome: string;
  };

  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalPaprHome: string | undefined;
  let originalPaprUserData: string | undefined;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalPaprHome = process.env.PAPR_HOME;
    originalPaprUserData = process.env.PAPR_USER_DATA;
    originalHomedir = os.homedir;

    // randomUUID, not Date.now(): two tests starting in the same millisecond
    // would otherwise silently share one workspace.
    handle.homeDir = path.join(
      os.tmpdir(),
      `${label}-${process.pid}-${randomUUID()}`,
    );
    handle.paprHome = path.join(handle.homeDir, "Papr");

    await fs.mkdir(handle.paprHome, { recursive: true });
    await fs.mkdir(path.join(handle.homeDir, ".paprwork-v2"), {
      recursive: true,
    });

    process.env.HOME = handle.homeDir;
    process.env.USERPROFILE = handle.homeDir; // Windows
    process.env.PAPR_HOME = handle.paprHome;
    process.env.PAPR_USER_DATA = path.join(handle.homeDir, ".paprwork-v2");

    // Modules that captured os.homedir at import time (AppService constructor
    // computes legacy paths from it) must also see the temp home.
    (os as { homedir: () => string }).homedir = () => handle.homeDir;

    // Kill the pointer path: getActiveWorkspacePointerPath() joins
    // getPaprBaseDir() (= <home>/Papr), so writing nothing here means
    // readActiveWorkspacePointer() returns null and PAPR_HOME wins.
    await fs
      .rm(path.join(handle.paprHome, ".active-workspace.json"), { force: true })
      .catch(() => {});
  });

  afterEach(async () => {
    (os as { homedir: () => string }).homedir = originalHomedir;
    restoreEnv("HOME", originalHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    restoreEnv("PAPR_HOME", originalPaprHome);
    restoreEnv("PAPR_USER_DATA", originalPaprUserData);

    await fs
      .rm(handle.homeDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
      .catch(() => {});
  });

  return handle;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
