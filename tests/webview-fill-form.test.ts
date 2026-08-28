import { describe, expect, it } from "vitest";
import { buildWebviewFillFormScript } from "../src/core/tools/webview.js";

describe("buildWebviewFillFormScript", () => {
  it("generates a script that returns fill results", () => {
    const script = buildWebviewFillFormScript([
      { selector: "#task", value: "Buy milk" },
    ]);
    expect(script).toContain("#task");
    expect(script).toContain("filledCount");
  });
});
