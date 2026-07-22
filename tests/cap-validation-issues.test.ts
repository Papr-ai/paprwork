import { describe, expect, test } from "vitest";
import {
  buildCappedRuntimeErrorList,
  buildCappedValidationIssueList,
  MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT,
} from "../src/core/utils/capValidationIssues.js";

describe("capValidationIssues", () => {
  test("caps validation issues with errors first", () => {
    const issues = [
      ...Array.from({ length: 10 }, (_, i) => ({
        file: `warn-${i}.ts`,
        severity: "warning" as const,
        message: `warning ${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        file: `err-${i}.ts`,
        line: i + 1,
        severity: "error" as const,
        message: `error ${i}`,
      })),
    ];

    const list = buildCappedValidationIssueList(issues);
    const lines = list.split("\n");

    expect(lines.length).toBe(MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT + 1);
    expect(lines[0]).toContain("err-0.ts:1");
    expect(lines[MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT]).toContain(
      "7 more issue(s)",
    );
  });

  test("caps runtime error list", () => {
    const errors = Array.from({ length: 12 }, (_, i) => `Runtime failure ${i}`);
    const list = buildCappedRuntimeErrorList(errors);
    expect(list).toContain("Runtime failure 0");
    expect(list).toContain("4 more runtime error(s)");
    expect(list.split("\n").length).toBe(MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT + 1);
  });
});
