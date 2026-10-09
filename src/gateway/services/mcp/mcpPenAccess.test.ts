import { describe, expect, it } from "vitest";
import { decidePenAccess, effectivePenAccess } from "./mcpPenAccess.js";

describe("Pen access", () => {
  const RO = { readOnlyHint: true };
  const DEL = { destructiveHint: true };

  it("read only: flagged reads run, everything else is refused", () => {
    expect(decidePenAccess("read", RO)).toBe("allow");
    expect(decidePenAccess("read", undefined)).toBe("deny");
  });

  it("ask: reads run, changes ask", () => {
    expect(decidePenAccess("ask", RO)).toBe("allow");
    expect(decidePenAccess("ask", undefined)).toBe("ask");
  });

  it("full: changes run, deletes still ask", () => {
    expect(decidePenAccess("full", undefined)).toBe("allow");
    expect(decidePenAccess("full", DEL)).toBe("ask");
  });

  it("is capped by the org and defaults to ask", () => {
    expect(effectivePenAccess("full", "read")).toBe("read");
    expect(effectivePenAccess("read", "full")).toBe("read");
    expect(effectivePenAccess(undefined, undefined)).toBe("ask");
    expect(effectivePenAccess("bogus", "ask")).toBe("ask");
  });
});

describe("Pen gate: the agent's tool call resumes after the answer", () => {
  it("waits for a slow answer, then runs; decline/timeout return guidance for the agent", async () => {
    const { createPenGate } = await import("./mcpPenGate.js");
    let answer: "yes" | "no" | "timeout" = "yes";
    const gate = createPenGate({
      keyLevel: async () => "ask",
      orgMax: async () => undefined,
      serverName: () => "Linear",
      ask: () =>
        new Promise((res, rej) => setTimeout(() => (answer === "timeout" ? rej(new Error("timed out")) : res(answer === "yes")), 50)),
    });
    await expect(gate("linear", "create_issue", undefined)).resolves.toBeUndefined();
    answer = "no";
    await expect(gate("linear", "create_issue", undefined)).rejects.toThrow(/declined.*Do not retry/);
    answer = "timeout";
    await expect(gate("linear", "create_issue", undefined)).rejects.toThrow(/No answer.*10 minutes/);
  });
});
