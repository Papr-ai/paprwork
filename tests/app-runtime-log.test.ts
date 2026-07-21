import { describe, expect, it, beforeEach } from "vitest";
import {
  AppRuntimeLogService,
  formatRuntimeLogLine,
  normalizePreviewConsoleLevel,
} from "../src/gateway/services/AppRuntimeLogService.js";

describe("AppRuntimeLogService", () => {
  let service: AppRuntimeLogService;

  beforeEach(() => {
    service = new AppRuntimeLogService();
  });

  it("stores and retrieves logs per appId", () => {
    service.append("app-1", {
      level: "error",
      message: "ReferenceError: x is not defined",
      source: "app.ts",
      line: 12,
      timestamp: new Date().toISOString(),
      origin: "iframe",
    });

    const logs = service.getLogs("app-1");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain("ReferenceError");
  });

  it("ring-buffers at 200 entries per app", () => {
    for (let i = 0; i < 210; i++) {
      service.append("app-1", {
        level: "log",
        message: `msg-${i}`,
        timestamp: new Date().toISOString(),
        origin: "iframe",
      });
    }
    expect(service.getLogs("app-1", { limit: 300 })).toHaveLength(200);
    expect(service.getLogs("app-1", { limit: 1 })[0]?.message).toBe("msg-209");
  });

  it("filters error messages for validate_app", () => {
    service.append("app-1", {
      level: "warn",
      message: "deprecated API",
      timestamp: new Date().toISOString(),
      origin: "iframe",
    });
    service.append("app-1", {
      level: "error",
      message: "click handler failed",
      timestamp: new Date().toISOString(),
      origin: "iframe",
    });

    const errors = service.getErrorMessages("app-1");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("click handler failed");
  });

  it("formatRuntimeLogLine includes source location", () => {
    const line = formatRuntimeLogLine({
      level: "error",
      message: "boom",
      source: "lesson-plans.ts",
      line: 31,
      timestamp: new Date().toISOString(),
      origin: "iframe",
    });
    expect(line).toContain("[iframe]");
    expect(line).toContain("lesson-plans.ts:31");
  });
});

describe("normalizePreviewConsoleLevel", () => {
  it("maps Electron numeric levels", () => {
    expect(normalizePreviewConsoleLevel(3)).toBe("error");
    expect(normalizePreviewConsoleLevel(2)).toBe("warn");
    expect(normalizePreviewConsoleLevel(1)).toBe("info");
  });
});
