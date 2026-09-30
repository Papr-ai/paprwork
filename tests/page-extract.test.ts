import { describe, it, expect } from "vitest";
import {
  buildSections,
  formatElements,
  formatSections,
  rankAgainstGoal,
  refSelector,
  EXTRACT_PAGE_SCRIPT,
  type ItemScorer,
} from "../src/core/tools/pageExtract.js";

describe("pageExtract", () => {
  it("groups text under heading paths", () => {
    const s = buildSections([
      { h: 1, t: "Pricing" },
      { h: 2, t: "Standard" },
      { h: 0, t: "Input $3 / MTok" },
      { h: 2, t: "Batch API" },
      { h: 0, t: "Input $1.50 / MTok" },
    ]);
    expect(s).toEqual([
      { path: "Pricing > Standard", text: "Input $3 / MTok" },
      { path: "Pricing > Batch API", text: "Input $1.50 / MTok" },
    ]);
  });

  it("resets deeper headings when a shallower one appears", () => {
    const s = buildSections([
      { h: 2, t: "A" },
      { h: 3, t: "A1" },
      { h: 0, t: "x" },
      { h: 2, t: "B" },
      { h: 0, t: "y" },
    ]);
    expect(s.map((x) => x.path)).toEqual(["A > A1", "B"]);
  });

  it("splits long text into ~700 char sections", () => {
    const s = buildSections([{ h: 0, t: "w ".repeat(1000) }]);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.text.length <= 700)).toBe(true);
  });

  it("formats and truncates", () => {
    const secs = buildSections([{ h: 1, t: "T" }, { h: 0, t: "a".repeat(600) }, { h: 2, t: "U" }, { h: 0, t: "b".repeat(600) }]);
    const f = formatSections(secs, 700);
    expect(f.truncated).toBe(true);
    expect(f.text).toContain("## T");
    const e = formatElements(
      [{ ref: 0, kind: "link", text: "Pricing", href: "https://x.com/pricing" }, { ref: 1, kind: "button", text: "Go" }],
      "https://x.com/",
      1,
    );
    expect(e.text).toContain('[0] link "Pricing" -> /pricing');
    expect(e.text).toContain("1 more");
  });

  it("ranks sections and elements with an injected scorer", async () => {
    const scorer: ItemScorer = async (_g, kind, items) =>
      Object.fromEntries(Object.entries(items).map(([k, v]) => [k, /pricing|\$3/i.test(v) ? 3 : 0]));
    const r = await rankAgainstGoal(
      "price",
      [{ path: "About", text: "we are nice" }, { path: "Pricing", text: "$3 per seat" }],
      [{ ref: 0, kind: "link", text: "Blog" }, { ref: 7, kind: "link", text: "Pricing", href: "https://x.com/pricing" }],
      "https://x.com/",
      { scorer },
    );
    expect(r.sections[0].path).toBe("Pricing");
    expect(r.bestSectionScore).toBe(3);
    expect(r.elements[0].ref).toBe(7);
  });

  it("builds ref selectors and a self-invoking extraction script", () => {
    expect(refSelector(4)).toBe('[data-pjid="4"]');
    expect(EXTRACT_PAGE_SCRIPT.trim().startsWith("(() =>")).toBe(true);
    expect(() => new Function(`return ${EXTRACT_PAGE_SCRIPT}`)).not.toThrow();
  });
});
