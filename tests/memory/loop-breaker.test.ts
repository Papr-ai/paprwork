import { beforeEach, describe, expect, test } from "vitest";
import { checkLoop, resetLoopState } from "../../src/core/tools/loopBreaker.js";

describe("loop breaker (papr-code-harness v1.2)", () => {
  beforeEach(() => resetLoopState());

  test("same command + same output: note from the 2nd repeat", () => {
    const out = Array.from({ length: 4 }, () => checkLoop("chat-1", "grep -rn site_title src/meta/configs.js", "exit=1"));
    expect(out[0]).toBe("");
    expect(out[1]).toBe("");
    expect(out[2]).toContain("loop detected");
    expect(out[3]).toContain("3 repeats");
  });

  test("edit/test cycles and changing output are not loops", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkLoop("c", `sed -i 's/a${i}/b/' x.py`, "")).toBe("");
      expect(checkLoop("c", "pytest -q", `${i} failed`)).toBe("");
    }
  });

  test("sessions are independent and whitespace is normalised", () => {
    checkLoop("a", "ls  -la", "x");
    checkLoop("a", "ls -la ", "x");
    expect(checkLoop("b", "ls -la", "x")).toBe("");
    expect(checkLoop("a", "ls -la", "x")).toContain("loop detected");
  });

  test("a different command resets the run", () => {
    for (let i = 0; i < 3; i++) checkLoop("r", "cat a", "same");
    expect(checkLoop("r", "cat b", "other")).toBe("");
    expect(checkLoop("r", "cat a", "same")).toBe("");
  });
});
