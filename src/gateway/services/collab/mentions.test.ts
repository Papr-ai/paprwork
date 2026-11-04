import { describe, expect, it } from "vitest";
import { isCollabEvent, mentionMessageText, parseSuggestion, type MentionCardData } from "./mentions";
import { matchTeammate } from "../../../core/tools/collab";

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
    expect(t).toContain("Ship pricing (due 2026-11-05)");
    expect(t).toContain("Mention id: m1");
    expect(isCollabEvent({ type: "mention.replied" })).toBe(true);
    expect(isCollabEvent({ type: "proposal.accepted" })).toBe(false);
  });
});
