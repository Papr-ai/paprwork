import { describe, expect, it } from "vitest";
import { isCollabEvent, mentionMessageText, parseSuggestion, type MentionCardData } from "./mentions";
import { matchTeammate, mentionSummary, openAsksFrom } from "../../../core/tools/collab";

const team = [
  { userId: "u1", displayName: "Shawkat Kabbara", email: "shawkat@papr.ai" },
  { userId: "u2", displayName: "Amir Kabbara", email: "amir@papr.ai" },
  { userId: "u3", displayName: "Sam Lee", email: "sam@papr.ai" },
];

describe("parseSuggestion", () => {
  it("reads JSON, even wrapped in prose", () => {
    expect(parseSuggestion('Sure: {"reply":"On it.","nextStep":"Open the PR"}')).toEqual({ reply: "On it.", nextStep: "Open the PR" });
  });
  it("falls back to the raw text, and null when empty", () => {
    expect(parseSuggestion("Thanks, will do.")).toEqual({ reply: "Thanks, will do." });
    expect(parseSuggestion('{"reply":""}')).toBeNull();
    expect(parseSuggestion(null)).toBeNull();
  });
});

describe("matchTeammate", () => {
  it("matches first name, email and id", () => {
    expect(matchTeammate("@Shawkat", team)).toMatchObject({ userId: "u1" });
    expect(matchTeammate("sam@papr.ai", team)).toMatchObject({ userId: "u3" });
    expect(matchTeammate("u2", team)).toMatchObject({ userId: "u2" });
  });
  it("asks for an email when ambiguous, says so when unknown", () => {
    expect(matchTeammate("Kabbara", team)).toHaveProperty("error");
    expect((matchTeammate("Zed", team) as { error: string }).error).toMatch(/No one/);
  });
});

describe("mention card text", () => {
  it("carries the id Pen needs to answer", () => {
    const c: MentionCardData = { type: "mention_inbox", itemId: "m1", fromName: "Amir", text: "Approved. Ship it?", context: { chatTitle: "Q4" },
      action: { title: "Ship pricing", due: "2026-11-05" }, suggestedReply: "On it.", status: "open" };
    const t = mentionMessageText(c);
    expect(t).toContain("Amir mentioned you in “Q4”");
    expect(t).toContain("Ship pricing (due Thu, Nov 5)");
    expect(t).toContain("Mention id: m1");
    expect(isCollabEvent({ type: "mention.replied" })).toBe(true);
    expect(isCollabEvent({ type: "proposal.accepted" })).toBe(false);
  });
});

describe("openAsksFrom", () => {
  const inbox = [{ fromUserId: "u1", id: "a" }, { fromUserId: "u3", id: "b" }, { fromUserId: "u1", id: "c" }];
  it("keeps only open asks from the people being mentioned", () => {
    expect(openAsksFrom(inbox, [team[0]]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(openAsksFrom(inbox, [team[1]])).toEqual([]);
    expect(openAsksFrom([], team)).toEqual([]);
  });
});

describe("mentionSummary", () => {
  const base = { id: "m1", fromUserId: "u2", fromName: "Amir", toUserId: "u1", toName: "Shawkat", text: "Review #447", context: {},
    action: null, status: "open" as const, reply: null, createdAt: "2026-11-06T19:16:00Z" };
  it("reads as asked with no reply, in_progress once they answered", () => {
    expect(mentionSummary(base).progress).toBe("asked");
    expect(mentionSummary({ ...base, reply: { text: "On it", at: "x" } }).progress).toBe("in_progress");
    expect(mentionSummary({ ...base, progress: "cant" }).progress).toBe("cant");
    expect(mentionSummary({ ...base, reply: { text: "Which one?", at: "x" }, progress: "needs_reply" }).progress).toBe("needs_reply");
  });
  it("carries the thread and the app the ask is about", () => {
    const s = mentionSummary({ ...base, context: { appId: "app1", appName: "Customer Contacts" },
      thread: [{ by: "from", text: "Please send it", at: "t1" }], promisedAt: "2026-11-07T17:00:00Z" });
    expect(s.about).toMatchObject({ appId: "app1", appName: "Customer Contacts" });
    expect(s.thread).toEqual([{ by: "from", text: "Please send it", at: "t1" }]);
    expect(s.promisedAt).toBe("2026-11-07T17:00:00Z");
  });
});

describe("parseInvestigation", () => {
  it("keeps findings and typed plan steps", async () => {
    const { parseInvestigation } = await import("./mentions");
    const r = parseInvestigation('ok {"findings":"audit db is empty","reply":"Checking now.","plan":[{"step":"Query db","kind":"check"},{"step":"Relink audit","kind":"change"},{"step":""}]}');
    expect(r).toEqual({ reply: "Checking now.", findings: "audit db is empty", plan: [{ step: "Query db", kind: "check" }, { step: "Relink audit", kind: "change" }] });
  });
  it("returns null without a reply", async () => {
    const { parseInvestigation } = await import("./mentions");
    expect(parseInvestigation(null)).toBeNull();
  });
});
