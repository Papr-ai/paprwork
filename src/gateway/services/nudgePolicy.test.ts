import { describe, expect, it } from "vitest";
import {
  applyNudgeEvent,
  cooldownMs,
  decideNudge,
  emptyLedger,
  sanitizeCandidate,
  type NudgeCandidate,
} from "./nudgePolicy";
import { focusNudgeCandidates, shortGoal } from "./nudges";

// Tue Sep 29 2026, 10:00 local — a weekday inside working hours.
const at = (d: number, h = 10, m = 0) => new Date(2026, 8, d, h, m);
const TUE = at(29);

const cand = (key: string, priority = 2, kind = "drift"): NudgeCandidate => ({
  key, kind, line: "x", go: "Go", later: "Later", action: { type: "focus" }, priority, source: "test",
});

describe("decideNudge — default is silence", () => {
  it("offers the highest-priority candidate when every rule agrees", () => {
    const d = decideNudge(emptyLedger(), [cand("a", 1), cand("b", 3)], TUE);
    expect(d.reason).toBe("ok");
    expect(d.nudge?.key).toBe("b");
  });

  it("stays quiet outside working hours and on weekends", () => {
    expect(decideNudge(emptyLedger(), [cand("a")], at(29, 8, 59)).reason).toBe("quiet-hours");
    expect(decideNudge(emptyLedger(), [cand("a")], at(29, 18)).reason).toBe("quiet-hours");
    expect(decideNudge(emptyLedger(), [cand("a")], at(27)).reason).toBe("weekend"); // Sunday
  });

  it("allows at most one per day", () => {
    const l = applyNudgeEvent(emptyLedger(), { key: "a", kind: "drift", event: "shown" }, at(29, 9, 30));
    expect(decideNudge(l, [cand("b")], at(29, 17)).reason).toBe("daily-cap");
  });

  it("never shows the same key twice", () => {
    let l = applyNudgeEvent(emptyLedger(), { key: "a", kind: "due", event: "shown" }, at(21));
    l = applyNudgeEvent(l, { key: "a", kind: "due", event: "go" }, at(21));
    expect(decideNudge(l, [cand("a")], TUE).reason).toBe("nothing-worth-it");
  });

  it("backs off exponentially while nudges are ignored, and resets on go", () => {
    let l = emptyLedger();
    l = applyNudgeEvent(l, { key: "a", kind: "drift", event: "shown" }, at(21)); // Mon
    expect(cooldownMs(l)).toBe(20 * 3_600_000);
    l = applyNudgeEvent(l, { key: "b", kind: "drift", event: "shown" }, at(22)); // ignored again
    expect(cooldownMs(l)).toBe(40 * 3_600_000);
    expect(decideNudge(l, [cand("c")], at(23, 17)).reason).toBe("cooldown"); // 31h later
    expect(decideNudge(l, [cand("c")], at(24, 10)).reason).toBe("ok"); // 48h later
    l = applyNudgeEvent(l, { key: "b", kind: "drift", event: "go" }, at(22));
    expect(l.unengaged).toBe(0);
  });

  it("caps backoff at 7 days", () => {
    const l = { ...emptyLedger(), unengaged: 12 };
    expect(cooldownMs(l)).toBe(7 * 86_400_000);
  });

  it("caps the week at three", () => {
    let l = { ...emptyLedger() };
    for (const d of [22, 23, 24]) l = applyNudgeEvent(l, { key: `k${d}`, kind: "due", event: "shown" }, at(d, 9));
    l = { ...l, unengaged: 0 }; // even when engaged, the weekly cap holds
    expect(decideNudge(l, [cand("z")], at(28, 11)).reason).toBe("weekly-cap");
  });

  it('"It\'s intentional" mutes that kind for a week', () => {
    let l = applyNudgeEvent(emptyLedger(), { key: "a", kind: "drift", event: "shown" }, at(21));
    l = applyNudgeEvent(l, { key: "a", kind: "drift", event: "dismiss" }, at(21));
    l = { ...l, unengaged: 0 };
    expect(decideNudge(l, [cand("b", 3, "drift")], at(24)).reason).toBe("nothing-worth-it");
    expect(decideNudge(l, [cand("b", 3, "due")], at(24)).nudge?.key).toBe("b");
  });

  it("reopening a parked nudge is not a second show", () => {
    let l = applyNudgeEvent(emptyLedger(), { key: "a", kind: "due", event: "shown" }, TUE);
    l = applyNudgeEvent(l, { key: "a", kind: "due", event: "shown" }, at(29, 14));
    expect(l.shown).toHaveLength(1);
    expect(l.unengaged).toBe(1);
  });
});

describe("sanitizeCandidate — jobs can suggest, not shout", () => {
  it("rejects proposals without a line, a move or an action", () => {
    expect(sanitizeCandidate({ key: "x", line: "Hi" }, TUE)).toBeNull();
    expect(sanitizeCandidate({ key: "x", line: "Hi", go: "Go", action: { type: "shell" } }, TUE)).toBeNull();
  });

  it("namespaces the key, clamps priority and expiry", () => {
    const c = sanitizeCandidate(
      { key: "brief-1", line: "Reply to Dana", go: "Draft it", priority: 9, action: { type: "chat", prompt: "Draft a reply" }, expiresAt: "2030-01-01" },
      TUE,
    );
    expect(c?.key).toBe("job:brief-1");
    expect(c?.priority).toBe(3);
    expect(Date.parse(c!.expiresAt!) - TUE.getTime()).toBeLessThanOrEqual(3 * 86_400_000);
  });
});

describe("focusNudgeCandidates — numbers, not nagging", () => {
  const goal = (id: string, hours7: number, due?: string) =>
    ({ id, title: `Goal ${id}`, due, signals: { hours7 } }) as never;

  it("flags a goal due within two days that got under an hour", () => {
    const c = focusNudgeCandidates({ three: [goal("G1", 0.2, "2026-09-30")], weekHours: 2 }, TUE);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "due", priority: 3, line: "Goal G1 is due tomorrow." });
  });

  it("ignores due goals that are getting time", () => {
    expect(focusNudgeCandidates({ three: [goal("G1", 3, "2026-09-30")], weekHours: 4 }, TUE)).toHaveLength(0);
  });

  it("flags drift only when the week is substantial and #1 got under 15%", () => {
    const drift = focusNudgeCandidates({ three: [goal("G1", 2)], weekHours: 16 }, TUE);
    expect(drift[0]).toMatchObject({ kind: "drift", line: "Goal G1 got 2h of your 16h this week." });
    expect(focusNudgeCandidates({ three: [goal("G1", 0)], weekHours: 4 }, TUE)).toHaveLength(0);
    expect(focusNudgeCandidates({ three: [goal("G1", 5)], weekHours: 16 }, TUE)).toHaveLength(0);
  });
});

describe("shortGoal — one glanceable clause", () => {
  it("keeps the first clause of a long goal", () => {
    expect(shortGoal("Close pre-seed Tranche 1 and build a $1-2M-lead-capable pipeline for Tranche 2")).toBe(
      "Close pre-seed Tranche 1",
    );
    expect(shortGoal("Validate MHAR depth-router + file patent claims")).toBe("Validate MHAR depth-router + file patent claims");
  });

  it("trims at a word boundary with an ellipsis when one clause is still too long", () => {
    const s = shortGoal("Ship a validated Stage-A pretraining pipeline for papr-embed-v2 on spot H100");
    expect(s.length).toBeLessThanOrEqual(49);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toBe("Ship a validated Stage-A pretraining pipeline…");
  });
});
