import { describe, expect, it } from "vitest";
import { findVetoes } from "./architectTriage.js";

describe("architect triage ignores risks the request rules out", () => {
  it("the to-do request Pen sent over iMessage is not vetoed", () => {
    const text =
      "Simple to-do list app with add task, check off, delete. Seed with 2 sample tasks. " +
      "Single screen, no backend jobs needed.\nSingle-screen frontend only, SQLite for tasks, no scheduling.";
    expect(findVetoes(text)).toEqual([]);
  });

  it.each([
    "no backend jobs or scheduling needed",
    "doesn't need sign-in",
    "without any webhook",
    "does not need a daily refresh",
  ])("%s → no veto", (text) => {
    expect(findVetoes(text)).toEqual([]);
  });

  it.each([
    ["send me a daily digest, no login", "schedule/background"],
    ["no login but a daily digest", "schedule/background"],
    ["team members share a board", "multi-user/access"],
    ["post to Slack when done", "integrations"],
  ])("%s → still vetoed", (text, label) => {
    expect(findVetoes(text)).toContain(label);
  });
});
