import { describe, expect, test } from "vitest";
import {
  formatGoalsOkrsBlock,
  formatUseCasesBlock,
  type ParseGoalRecord,
  type ParseUsecaseRecord,
} from "../src/gateway/utils/parseUserContext.js";
import { classifyMemoryBlock } from "../src/gateway/services/UserMemoryContextService.js";

describe("parseUserContext formatting", () => {
  test("formatGoalsOkrsBlock includes title, description, and key results", () => {
    const goals: ParseGoalRecord[] = [
      {
        objectId: "goal-1",
        title: "Ship Paprwork V2",
        description: "Complete greenfield rewrite with reliable agent tooling.",
        keyResults: ["Launch beta", { title: "80% test coverage" }],
        updatedAt: "2026-06-01T12:00:00.000Z",
      },
    ];

    const block = formatGoalsOkrsBlock(goals);
    expect(block).toBeDefined();
    if (!block) {
      return;
    }

    expect(block).toContain("[USER GOALS & OKRs");
    expect(block).toContain("Ship Paprwork V2");
    expect(block).toContain("Key Results:");
    expect(block).toContain("Launch beta");
    expect(block).toContain("80% test coverage");
    expect(classifyMemoryBlock(block)).toBe("parse_goals");
  });

  test("formatUseCasesBlock includes use case name and description", () => {
    const usecases: ParseUsecaseRecord[] = [
      {
        objectId: "uc-1",
        name: "Daily briefings",
        description: "Morning dashboard with priorities and meetings.",
        updatedAt: "2026-05-15T08:00:00.000Z",
      },
    ];

    const block = formatUseCasesBlock(usecases);
    expect(block).toBeDefined();
    if (!block) {
      return;
    }

    expect(block).toContain("[USER USE CASES");
    expect(block).toContain("Daily briefings");
    expect(block).toContain("Morning dashboard");
    expect(classifyMemoryBlock(block)).toBe("parse_usecases");
  });

  test("format blocks return undefined when empty", () => {
    expect(formatGoalsOkrsBlock([])).toBeUndefined();
    expect(formatUseCasesBlock([])).toBeUndefined();
  });
});
