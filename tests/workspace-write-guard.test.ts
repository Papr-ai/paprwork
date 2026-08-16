import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeWorkspace = path.join(os.tmpdir(), "papr-write-guard-active");

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: () => activeWorkspace,
}));

import {
  assertWorkspaceWriteAllowed,
  bumpWorkspaceWriteGeneration,
  canPerformWorkspaceDbWrite,
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
  isPaprDirInActiveWorkspace,
  isWorkspaceWriteStale,
  resetWorkspaceWriteGenerationForTests,
  WorkspaceWriteBlockedError,
} from "../src/gateway/services/workspaceWriteGuard.js";

describe("workspace write guard", () => {
  afterEach(() => {
    resetWorkspaceWriteGenerationForTests();
  });

  it("bumps generation and marks prior captures stale", () => {
    const captured = getWorkspaceWriteGeneration();
    expect(captured).toBe(0);
    expect(isWorkspaceWriteStale(captured)).toBe(false);

    bumpWorkspaceWriteGeneration("test switch");
    expect(getWorkspaceWriteGeneration()).toBe(1);
    expect(isWorkspaceWriteStale(captured)).toBe(true);
  });

  it("blocks writes when generation is stale", () => {
    const captured = getWorkspaceWriteGeneration();
    bumpWorkspaceWriteGeneration("test switch");

    expect(
      canPerformWorkspaceWrite(captured, activeWorkspace, "cloud sync"),
    ).toBe(false);
  });

  it("blocks writes outside active workspace paprDir", () => {
    const other = path.join(os.tmpdir(), "papr-write-guard-other");
    expect(
      canPerformWorkspaceWrite(0, other, "publish app"),
    ).toBe(false);
    expect(isPaprDirInActiveWorkspace(other)).toBe(false);
    expect(isPaprDirInActiveWorkspace(activeWorkspace)).toBe(true);
  });

  it("allows writes when generation and paprDir match", () => {
    const captured = getWorkspaceWriteGeneration();
    expect(
      canPerformWorkspaceWrite(captured, activeWorkspace, "git push"),
    ).toBe(true);
  });

  it("blocks DB writes outside active workspace", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "papr-db-other-"));
    const dbPath = path.join(other, "data", "databases", "demo", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite");

    expect(
      canPerformWorkspaceDbWrite(0, dbPath, "turso push"),
    ).toBe(false);

    fs.rmSync(other, { recursive: true, force: true });
  });

  it("assertWorkspaceWriteAllowed throws WorkspaceWriteBlockedError", () => {
    bumpWorkspaceWriteGeneration("test switch");
    expect(() =>
      assertWorkspaceWriteAllowed(0, activeWorkspace, "commit"),
    ).toThrow(WorkspaceWriteBlockedError);
  });
});
