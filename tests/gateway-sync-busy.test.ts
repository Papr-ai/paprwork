import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearGatewaySyncBusy,
  isGatewaySyncBusyGraceActive,
  markGatewaySyncBusy,
  readGatewaySyncBusyState,
} from "../src/gateway/services/cloudSync/syncBusyState.js";

describe("gateway sync busy state", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("mark and read busy state", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-busy-"));
    markGatewaySyncBusy(
      {
        appId: "app-1",
        operation: "flush",
        startedAtMs: Date.now(),
        trigger: "manual",
      },
      tempDir,
    );
    const state = readGatewaySyncBusyState(tempDir);
    expect(state?.appId).toBe("app-1");
    expect(state?.operation).toBe("flush");
  });

  test("clear removes busy marker", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-busy-"));
    markGatewaySyncBusy(
      {
        appId: "app-1",
        operation: "flush",
        startedAtMs: Date.now(),
      },
      tempDir,
    );
    clearGatewaySyncBusy(tempDir);
    expect(readGatewaySyncBusyState(tempDir)).toBeNull();
  });

  test("grace active within 15 minutes", () => {
    const state = {
      appId: "app-1",
      operation: "flush" as const,
      startedAtMs: Date.now() - 60_000,
    };
    expect(isGatewaySyncBusyGraceActive(state)).toBe(true);
  });

  test("grace expired after 15 minutes", () => {
    const state = {
      appId: "app-1",
      operation: "flush" as const,
      startedAtMs: Date.now() - 16 * 60_000,
    };
    expect(isGatewaySyncBusyGraceActive(state)).toBe(false);
  });
});
