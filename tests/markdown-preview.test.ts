import { describe, expect, test } from "vitest";
import { markdownPreviewText } from "../src/core/utils/markdownPreview.js";

describe("markdownPreviewText", () => {
  test("strips heading and bold markers from preview body", () => {
    const content = `# Paprwork Sync V3 — Target Architecture

**Goal:** replace ~37k lines of sync code with a simpler model.`;

    expect(markdownPreviewText(content)).toBe(
      "Goal: replace ~37k lines of sync code with a simpler model.",
    );
  });

  test("falls back to heading text when document has no body", () => {
    const content = "# Mini-App UX Architecture — Product-Manager Gate";

    expect(markdownPreviewText(content)).toBe(
      "Mini-App UX Architecture — Product-Manager Gate",
    );
  });

  test("removes list markers and inline code", () => {
    const content = `# Notes

- Use \`markdownPreviewText()\` for cards
- Keep previews short`;

    expect(markdownPreviewText(content)).toBe(
      "Use markdownPreviewText() for cards Keep previews short",
    );
  });

  test("respects max length with word-safe truncation", () => {
    const content = `# Title

${"word ".repeat(80)}`;

    const preview = markdownPreviewText(content, 40);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(41);
  });
});
