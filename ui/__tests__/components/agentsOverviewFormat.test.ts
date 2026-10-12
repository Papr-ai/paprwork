import { describe, expect, it } from "vitest";
import { chatTitle, scheduleLabel, tok, usd } from "../../components/Agents/overview/format";

describe("Agents overview format", () => {
  it("turns schedules into plain English", () => {
    expect(scheduleLabel({ cron: "0 7 * * *" })).toBe("Daily · 7:00 AM");
    expect(scheduleLabel({ cron: "30 10 * * 1" })).toBe("Mondays · 10:30 AM");
    expect(scheduleLabel({ cron: "15 * * * *" })).toBe("Hourly");
    expect(scheduleLabel({ cron: "23 9-18 * * 1-5" })).toBe("Hourly · weekdays 9–6");
    expect(scheduleLabel({ intervalMs: 900000 })).toBe("Every 15 min");
    expect(scheduleLabel({ cron: "0 0 1 * *" })).toBe("0 0 1 * *");
  });
  it("formats money, tokens and titles like the prototype", () => {
    expect(usd(3186.9)).toBe("$3,187");
    expect(usd(431.7)).toBe("$432");
    expect(tok(3_899_236_384)).toBe("3.90B");
    expect(chatTitle("New Chat")).toBe("Untitled chat");
    expect(chatTitle("Think through pricing...")).toBe("Think through pricing");
  });
});
