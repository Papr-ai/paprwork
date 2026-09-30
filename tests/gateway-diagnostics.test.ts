import { describe, expect, it } from "vitest";
import {
  diagnosticsBundleHasUsableData,
  redactDiagnosticsString,
  redactDiagnosticsValue,
  type GatewayDiagnosticsBundle,
} from "../ui/utils/gatewayDiagnostics.js";

describe("gatewayDiagnostics redaction", () => {
  it("redacts macOS home paths in strings", () => {
    const input = "failed at /Users/alice/Papr/apps/x";
    expect(redactDiagnosticsString(input)).toBe("failed at [HOME]");
  });

  it("detects usable bundle when health responds", () => {
    const bundle: GatewayDiagnosticsBundle = {
      collectedAt: new Date().toISOString(),
      gatewayBaseUrl: "http://localhost:18789",
      fetchTimeoutMs: 8000,
      endpoints: {
        "/health": { ok: true, status: 200, body: { status: "ok" } },
        "/api/workspace/switch-status": { ok: false, status: 0, body: {} },
        "/api/debug/gateway-background": { ok: false, status: 0, body: {} },
        "/api/debug/turso-worker-timings": { ok: false, status: 0, body: {} },
        "/api/debug/replica-read-phases": { ok: false, status: 0, body: {} },
      },
    };
    expect(diagnosticsBundleHasUsableData(bundle)).toBe(true);
  });

  it("redacts nested error fields", () => {
    const value = redactDiagnosticsValue({
      recentTasks: [
        {
          taskKey: "test",
          error: "ENOENT /Users/bob/.paprwork-v2/chats.db",
        },
      ],
    }) as { recentTasks: Array<{ error: string }> };
    expect(value.recentTasks[0].error).toBe("ENOENT [HOME]");
  });
});
