import { describe, expect, test } from "vitest";
import { checkMiniAppEmojiPatterns } from "../src/gateway/utils/miniAppEmojiLint.js";

describe("checkMiniAppEmojiPatterns", () => {
  test("errors on emoji in TSX UI strings", () => {
    const files = new Map<string, string>([
      [
        "app.tsx",
        `export function App() {
  return <h1>Welcome 👋</h1>;
}`,
      ],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("no-emojis");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.line).toBe(2);
  });

  test("errors on emoji in HTML", () => {
    const files = new Map<string, string>([
      ["index.html", '<button>Save ✅</button>'],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues.some((i) => i.rule === "no-emojis")).toBe(true);
  });

  test("passes clean SVG and text UI", () => {
    const files = new Map<string, string>([
      [
        "components/header.ts",
        `export const title = "Sales Dashboard";
export const icon = '<svg viewBox="0 0 24 24"><path d="M3 3"/></svg>';`,
      ],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues).toHaveLength(0);
  });

  test("ignores emoji mentioned in line comments", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `// Do not use emoji like 📊 in labels
export const label = "Revenue";`,
      ],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues).toHaveLength(0);
  });

  test("passes typography arrows used in documentation table cells", () => {
    const files = new Map<string, string>([
      [
        "today.ts",
        `export const rows = [
  ["Renderer ↔ Gateway", "IPC over WebSocket"],
  ["Gateway ↔ Jobs", "POST /api/jobs/run"],
];`,
      ],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues).toHaveLength(0);
  });

  test("skips non-source files", () => {
    const files = new Map<string, string>([
      ["metadata.json", '{"icon":"📊"}'],
    ]);
    const issues = checkMiniAppEmojiPatterns(files);
    expect(issues).toHaveLength(0);
  });
});
