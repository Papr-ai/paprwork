import { describe, expect, it } from "vitest";
import { applyOpenItemToggleToMarkdown } from "../src/gateway/services/wikiEntitySectionUpdate.js";

describe("applyOpenItemToggleToMarkdown", () => {
  const sample = `---
id: acme
updated_at: 2026-08-01
---

## Open Items

- [ ] Ship proposal
- [x] Intro call

## Changelog

- 2026-08-01 — Created
`;

  it("marks an open item complete and refreshes updated_at", () => {
    const updated = applyOpenItemToggleToMarkdown(sample, 0, true);
    expect(updated).toContain("- [x] Ship proposal");
    expect(updated).toContain("- [x] Intro call");
    expect(updated).toMatch(/updated_at: 2026-\d{2}-\d{2}/);
    expect(updated).not.toContain("updated_at: 2026-08-01");
  });

  it("throws when item index is out of range", () => {
    expect(() => applyOpenItemToggleToMarkdown(sample, 3, true)).toThrow(
      "out of range",
    );
  });

  it("preserves category tags when toggling", () => {
    const tagged = `---
id: acme
---

## Open Items

- [ ] [user] Ship proposal
- [ ] [agent] Fix sync

## Changelog
`;
    const updated = applyOpenItemToggleToMarkdown(tagged, 0, true);
    expect(updated).toContain("- [x] [user] Ship proposal");
    expect(updated).toContain("- [ ] [agent] Fix sync");
  });
});
