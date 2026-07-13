import { describe, expect, it } from "vitest";
import { transpileMiniAppTypeScript } from "../src/gateway/utils/miniAppTranspile.js";

describe("transpileMiniAppTypeScript", () => {
  it("transpiles valid TypeScript", async () => {
    const result = await transpileMiniAppTypeScript(
      "export const value = 1;\n",
      "app.ts",
    );

    expect(result.success).toBe(true);
    expect(result.code).toContain("export");
  });

  it("reports JSX syntax errors in .ts files", async () => {
    const result = await transpileMiniAppTypeScript(
      "export function App() { return <div class=\"x\" />; }\n",
      "sources.ts",
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Expected ">" but found "class"/);
    expect(result.line).toBe(1);
    expect(result.column).toBeGreaterThan(0);
  });

  it("transpiles valid TSX", async () => {
    const result = await transpileMiniAppTypeScript(
      "export function App() { return <div className=\"x\" />; }\n",
      "app.tsx",
    );

    expect(result.success).toBe(true);
    expect(result.code).toBeTruthy();
  });

  it("skips non-TypeScript files", async () => {
    const result = await transpileMiniAppTypeScript(
      "body { color: red; }",
      "style.css",
    );

    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
  });
});
