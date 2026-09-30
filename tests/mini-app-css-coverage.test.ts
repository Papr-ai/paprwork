import { describe, expect, it, beforeEach } from "vitest";
import {
  checkMiniAppCssClassCoverage,
  checkMiniAppCssShrink,
  countCssSelectorTokens,
  extractCssClassNames,
  resetCssSelectorBaselineForTests,
} from "../src/gateway/utils/miniAppCssCoverageLint.js";

describe("miniAppCssCoverageLint", () => {
  beforeEach(() => {
    resetCssSelectorBaselineForTests();
  });

  it("extractCssClassNames parses compound selectors", () => {
    const names = extractCssClassNames(".stat-row { display: flex; } .quote.block { margin: 0; }");
    expect(names.has("stat-row")).toBe(true);
    expect(names.has("quote")).toBe(true);
    expect(names.has("block")).toBe(true);
  });

  it("countCssSelectorTokens counts repeated tokens", () => {
    expect(countCssSelectorTokens(".a { } .a.b { }")).toBe(3);
  });

  it("flags markup classes missing from app CSS", () => {
    const files = new Map<string, string>([
      [
        "index.html",
        '<div class="stat-row"><p class="quote">Hi</p></div>',
      ],
      ["content.css", ".container { padding: 1rem; }"],
    ]);

    const issues = checkMiniAppCssClassCoverage(files);
    const rules = issues.map((issue) => issue.rule);
    expect(rules).toContain("css-class-coverage");
    expect(issues.some((issue) => issue.message.includes("stat-row"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("quote"))).toBe(true);
  });

  it("passes when app CSS defines markup classes", () => {
    const files = new Map<string, string>([
      ["index.html", '<div class="stat-row"><p class="quote">Hi</p></div>'],
      [
        "content.css",
        ".stat-row { display: flex; } .quote { font-style: italic; }",
      ],
    ]);

    const issues = checkMiniAppCssClassCoverage(files);
    expect(issues).toHaveLength(0);
  });

  it("ignores dynamic className template strings", () => {
    const files = new Map<string, string>([
      ["app.tsx", '<div className={`badge ${status}`}>x</div>'],
      ["style.css", ""],
    ]);

    const issues = checkMiniAppCssClassCoverage(files);
    expect(issues).toHaveLength(0);
  });

  it("warns on app-level CSS selector shrink between validate runs", () => {
    const appId = "test-shrink-app";
    const fullCss = new Map<string, string>([
      ["index.html", '<div class="stat-row"></div>'],
      [
        "content.css",
        [
          ".stat-row { display: flex; }",
          ".quote { font-style: italic; }",
          ".ask { padding: 8px; }",
          ".prose { line-height: 1.5; }",
          ".section-title { font-weight: 600; }",
        ].join("\n"),
      ],
    ]);

    checkMiniAppCssShrink(appId, fullCss);

    const trimmedCss = new Map<string, string>([
      ["index.html", '<div class="stat-row"></div>'],
      ["content.css", ".container { padding: 1rem; }"],
    ]);

    const issues = checkMiniAppCssShrink(appId, trimmedCss);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("css-shrink");
    expect(issues[0]?.message).toContain("selector count dropped");
  });

  it("does not warn on shrink for first validate baseline", () => {
    const files = new Map<string, string>([
      ["style.css", ".only { color: red; }"],
    ]);
    const issues = checkMiniAppCssShrink("fresh-app", files);
    expect(issues).toHaveLength(0);
  });
});
