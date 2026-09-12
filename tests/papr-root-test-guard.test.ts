/**
 * The test-only guard in `paprRoot.ts` decides whether a workspace path is
 * safe to write to during tests. It has to be exactly as strict as intended:
 * too loose and it stops protecting the developer's real `~/Papr` (which it
 * exists to protect, after ~305 fixture apps and 462 job folders leaked into a
 * live workspace on 2026-08-12); too strict and it rejects suites that are
 * using a temp directory correctly, which is what it had been doing on macOS.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getPaprRoot } from "../src/core/utils/paprRoot.js";

describe("paprRoot test guard", () => {
  let savedPaprHome: string | undefined;

  beforeEach(() => {
    savedPaprHome = process.env.PAPR_HOME;
  });

  afterEach(() => {
    if (savedPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = savedPaprHome;
    }
  });

  it("accepts a temp path whose directories do not exist yet", () => {
    // The regression this pins. On macOS `os.tmpdir()` is `/var/folders/...`,
    // a symlink to `/private/var/folders/...`. The guard realpaths the temp
    // root, so it must resolve the candidate the same way — and a workspace
    // path is routinely named before it is created, so `realpathSync` on the
    // whole path throws. Comparing the unresolved `/var/...` against the
    // resolved `/private/var/...` rejected perfectly safe suites.
    process.env.PAPR_HOME = path.join(
      os.tmpdir(),
      `papr-guard-${randomUUID()}`,
      "orgs",
      "org1",
      "namespaces",
      "ns-active",
    );

    expect(() => getPaprRoot()).not.toThrow();
  });

  it("accepts a temp path that does exist", () => {
    const dir = path.join(os.tmpdir(), `papr-guard-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    process.env.PAPR_HOME = dir;

    try {
      expect(() => getPaprRoot()).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a path outside the temp root", () => {
    // The guard's whole purpose. Resolving through missing leaves must not
    // have made this reachable: a non-temp path stays non-temp however much of
    // it exists on disk.
    process.env.PAPR_HOME = path.join(
      "/definitely-not-tmp",
      `papr-guard-${randomUUID()}`,
      "Papr",
    );

    expect(() => getPaprRoot()).toThrow(/Refusing to use a real Papr workspace/);
  });

  it("honours the documented escape hatch", () => {
    process.env.PAPR_HOME = path.join("/definitely-not-tmp", "Papr");
    process.env.PAPR_ALLOW_REAL_WORKSPACE_IN_TESTS = "1";

    try {
      expect(() => getPaprRoot()).not.toThrow();
    } finally {
      delete process.env.PAPR_ALLOW_REAL_WORKSPACE_IN_TESTS;
    }
  });
});

describe("default temp workspace setup", () => {
  it("leaves PAPR_HOME unset so a suite patching only HOME still wins", () => {
    // `tests/setup/defaultTempWorkspace.ts` deliberately clears PAPR_HOME
    // rather than setting it. `getPaprRoot()` consults PAPR_HOME before
    // `getPaprBaseDir()`, so setting it would silently outrank any suite that
    // patches only HOME — the suite would look like it had set up its own
    // workspace while every read went elsewhere. That broke
    // `db-path-normalization` on the first attempt at that setup file.
    expect(process.env.PAPR_HOME).toBeUndefined();
  });

  it("points HOME at a temp directory", () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();

    const tmpRoot = fs.realpathSync.native(os.tmpdir());
    const resolvedHome = fs.realpathSync.native(home as string);
    expect(resolvedHome.startsWith(tmpRoot)).toBe(true);
  });
});
