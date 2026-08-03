import { describe, expect, it } from "vitest";
import {
  logPaprLoginStep,
  PAPR_LOGIN_STEP_EVENT,
  type PaprLoginStep,
} from "../src/core/telemetry/paprLoginSteps.js";

describe("Papr login funnel telemetry", () => {
  it("exports step event name for Amplitude", () => {
    expect(PAPR_LOGIN_STEP_EVENT).toBe("paprwork_papr_login_step");
  });

  it("logs funnel steps with step property", () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    };
    try {
      logPaprLoginStep("callback_received", { has_code: true });
    } finally {
      console.log = original;
    }
    const combined = logs.join("\n");
    expect(combined).toContain("callback_received");
    expect(combined).toContain("has_code");
  });

  const expectedSteps: PaprLoginStep[] = [
    "auth_wall_viewed",
    "login_button_clicked",
    "browser_opened",
    "waiting_for_callback",
    "deep_link_queued",
    "callback_received",
    "token_exchanged",
    "login_success_notified",
    "login_timeout",
  ];

  it("includes full funnel step names", () => {
    for (const step of expectedSteps) {
      expect(typeof step).toBe("string");
      expect(step.length).toBeGreaterThan(0);
    }
  });
});
