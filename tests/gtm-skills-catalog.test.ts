import { describe, expect, test } from "vitest";
import { parseGtmskillsFrontmatter } from "../src/gateway/services/gtmSkillsCatalog.js";

describe("gtmSkillsCatalog", () => {
  test("parseGtmskillsFrontmatter reads title and description", () => {
    const parsed = parseGtmskillsFrontmatter(`---
name: "build-list"
title: Build list
description: "Builds prospect lists of companies, contacts, or both."
category: Prospecting
---

## Instructions
`);
    expect(parsed).toEqual({
      name: "Build list",
      description:
        "Builds prospect lists of companies, contacts, or both.",
      category: "Prospecting",
    });
  });
});
