import { describe, expect, it } from "vitest";
import { toolRepetitionDedupKey } from "../src/gateway/services/agent/toolRepetitionKey.js";

describe("toolRepetitionDedupKey", () => {
  const longPath =
    "/Users/amirkabbara/Papr/orgs/YqiHlOHGqg/namespaces/8Pu0Oc6pIh/apps/c39c707f-5ce3-4ec3-a462-e0c92790d4f0/lib/events-roster.ts";

  it("treats different edit_file patches to the same path as distinct", () => {
    const a = JSON.stringify({
      path: longPath,
      oldString: "const open = t.closest",
      newString: "const edit = t.closest",
    });
    const b = JSON.stringify({
      path: longPath,
      oldString: "function fill(",
      newString: "function fillValues(",
    });

    expect(toolRepetitionDedupKey("edit_file", a)).not.toBe(
      toolRepetitionDedupKey("edit_file", b),
    );
  });

  it("treats byte-identical tool calls as the same key", () => {
    const args = JSON.stringify({ path: longPath, oldString: "x", newString: "y" });
    expect(toolRepetitionDedupKey("edit_file", args)).toBe(
      toolRepetitionDedupKey("edit_file", args),
    );
  });

  it("separates keys by tool name", () => {
    const args = JSON.stringify({ command: "echo hi" });
    expect(toolRepetitionDedupKey("bash", args)).not.toBe(
      toolRepetitionDedupKey("read_file", args),
    );
  });
});
