import { describe, expect, test } from "vitest";
import {
  formatJobEventsFixGuidance,
  hasJobEventsPollingIssues,
} from "../src/gateway/utils/miniAppJobEventGuidance.js";

describe("miniAppJobEventGuidance", () => {
  test("formatJobEventsFixGuidance includes SDK import and snippet", () => {
    const guidance = formatJobEventsFixGuidance();
    expect(guidance).toContain("/__papr__/papr-job-events.ts");
    expect(guidance).toContain("onDbChanged");
    expect(guidance).toContain("preloaded-app-and-jobs-guide");
  });

  test("hasJobEventsPollingIssues detects polling rules", () => {
    expect(hasJobEventsPollingIssues([{ rule: "no-db-polling" }])).toBe(true);
    expect(hasJobEventsPollingIssues([{ rule: "prefer-job-events" }])).toBe(true);
    expect(hasJobEventsPollingIssues([{ rule: "max-lines" }])).toBe(false);
  });
});
