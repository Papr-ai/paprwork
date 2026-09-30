import { describe, it, expect } from "vitest";
import { recordBrowseAction, LOOKUP_NUDGE_HINT } from "../src/core/tools/browseNudge.js";

const rounds = (key: object, n: number) => {
  const hints: Array<string | undefined> = [recordBrowseAction(key, "snapshot")];
  for (let i = 0; i < n; i++) {
    recordBrowseAction(key, "click");
    hints.push(recordBrowseAction(key, "snapshot"));
  }
  return hints;
};

describe("browse nudge", () => {
  it("hints once after 3 snapshot→click rounds", () => {
    const k = {};
    const hints = rounds(k, 5);
    expect(hints.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(hints[3]).toBe(LOOKUP_NUDGE_HINT);
    expect(hints.slice(4)).toEqual([undefined, undefined]);
  });

  it("never hints when the agent is filling a form", () => {
    const k = {};
    recordBrowseAction(k, "input");
    expect(rounds(k, 5).filter(Boolean)).toEqual([]);
  });

  it("snapshots without clicks don't count", () => {
    const k = {};
    for (let i = 0; i < 6; i++) expect(recordBrowseAction(k, "snapshot")).toBeUndefined();
  });

  it("browser_goto resets the streak so it can nudge again later", () => {
    const k = {};
    expect(rounds(k, 3)[3]).toBe(LOOKUP_NUDGE_HINT);
    recordBrowseAction(k, "goto");
    expect(rounds(k, 3)[3]).toBe(LOOKUP_NUDGE_HINT);
  });

  it("sessions are independent", () => {
    const a = {}, b = {};
    rounds(a, 2);
    expect(rounds(b, 1).filter(Boolean)).toEqual([]);
    expect(rounds(a, 1).filter(Boolean)).toEqual([LOOKUP_NUDGE_HINT]);
  });
});
