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
