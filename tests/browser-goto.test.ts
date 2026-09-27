import { describe, it, expect } from "vitest";
import { runGoto, siteKey, type GotoPage } from "../src/core/tools/browserGoto.js";
import type { ItemScorer, RawExtraction } from "../src/core/tools/pageExtract.js";

/** Tiny fake site: each URL returns fixed blocks + elements. */
function fakeSite(pages: Record<string, RawExtraction>, start: string) {
  let current = start;
  const visits: string[] = [start];
  const page: GotoPage = {
    url: () => current,
    goto: async (u) => {
      if (!pages[u]) throw new Error(`404 ${u}`);
      current = u;
      visits.push(u);
    },
    click: async (sel) => {
      throw new Error(`no in-page click ${sel}`);
    },
    evaluate: async () => pages[current],
    settle: async () => {},
  };
  return { page, visits };
}

const link = (ref: number, text: string, href: string) => ({ ref, kind: "link", text, href });

// Scores by keyword: sections mentioning "audit" are the answer, links mentioning pricing/plans lead there.
const scorer: ItemScorer = async (_goal, kind, items) =>
  Object.fromEntries(
    Object.entries(items).map(([k, v]) => {
      if (kind === "sections") return [k, /audit log/i.test(v) ? 2.9 : 0.2];
      if (/log out/i.test(v)) return [k, 3];
      if (/pricing/i.test(v)) return [k, 2.5];
      if (/plans/i.test(v)) return [k, 1.8];
      if (/twitter/i.test(v)) return [k, 2.8];
      return [k, 0.1];
    }),
  );

const SITE: Record<string, RawExtraction> = {
  "https://acme.com/": {
    blocks: [{ h: 1, t: "Acme" }, { h: 0, t: "We build tools." }],
    elements: [
      link(0, "Log out", "https://acme.com/logout"),
      link(1, "Pricing", "https://acme.com/pricing"),
      link(2, "Follow us on Twitter", "https://twitter.com/acme"),
      link(3, "Blog", "https://acme.com/blog"),
    ],
  },
  "https://acme.com/pricing": {
    blocks: [{ h: 1, t: "Pricing" }, { h: 0, t: "Starter $10." }],
    elements: [link(0, "Compare plans", "https://acme.com/pricing/compare"), link(1, "Pricing", "https://acme.com/pricing")],
  },
  "https://acme.com/pricing/compare": {
    blocks: [{ h: 2, t: "Business" }, { h: 0, t: "SSO, audit logs, priority support." }],
    elements: [],
  },
};

describe("browser_goto loop", () => {
  it("follows the best same-site link and stops when a section answers the goal", async () => {
    const { page, visits } = fakeSite(SITE, "https://acme.com/");
    const r = await runGoto(page, "Does Business include audit logs?", { scorer });
    expect(r.found).toBe(true);
    expect(r.stopReason).toBe("found");
    expect(r.finalUrl).toBe("https://acme.com/pricing/compare");
    expect(r.passages[0].text).toMatch(/audit logs/);
    expect(r.passages[0].path).toBe("Business");
    // skipped log out (unsafe), twitter (offsite), and the self-link back to /pricing
    expect(visits).toEqual(["https://acme.com/", "https://acme.com/pricing", "https://acme.com/pricing/compare"]);
    expect(r.steps.map((s) => s.followed?.text)).toEqual(["Pricing", "Compare plans", undefined]);
  });

  it("respects maxSteps and reports low confidence when nothing is found", async () => {
    const { page } = fakeSite(SITE, "https://acme.com/");
    const r = await runGoto(page, "audit logs", { scorer, maxSteps: 1 });
    expect(r.found).toBe(false);
    expect(r.stopReason).toBe("max_steps");
    expect(r.steps).toHaveLength(1);
    expect(r.elements.join("\n")).toContain("Pricing");
  });

  it("stops when no link is promising", async () => {
    const dull: ItemScorer = async (_g, _k, items) => Object.fromEntries(Object.keys(items).map((k) => [k, 0.2]));
    const { page } = fakeSite(SITE, "https://acme.com/");
    const r = await runGoto(page, "anything", { scorer: dull });
    expect(r.stopReason).toBe("no_promising_links");
    expect(r.confidence).toBe("low");
  });

  it("records a failed follow and keeps going from the pool", async () => {
    const broken = { ...SITE, "https://acme.com/pricing/compare": undefined as unknown as RawExtraction };
    delete (broken as Record<string, unknown>)["https://acme.com/pricing/compare"];
    const { page } = fakeSite(broken, "https://acme.com/");
    const r = await runGoto(page, "audit logs", { scorer, maxSteps: 3 });
    expect(r.steps.some((s) => s.error?.includes("follow failed"))).toBe(true);
    expect(r.found).toBe(false);
  });

  it("groups subdomains under one site", () => {
    expect(siteKey("https://docs.acme.com/x")).toBe("acme.com");
    expect(siteKey("https://www.acme.com")).toBe("acme.com");
  });
});

describe("browser_goto list answers + unvisited", () => {
  const LIST: Record<string, RawExtraction> = {
    "https://vc.com/": {
      blocks: [{ h: 1, t: "Portfolio" }, { h: 2, t: "Linear" }, { h: 0, t: "dev tools" }, { h: 2, t: "Retool" }, { h: 0, t: "dev tools" }, { h: 2, t: "Vercel" }, { h: 0, t: "dev tools" }],
      elements: [link(0, "Pricing", "https://vc.com/pricing")],
    },
  };
  it("counts several partial sections on one page as found", async () => {
    const partial: ItemScorer = async (_g, kind, items) =>
      Object.fromEntries(Object.keys(items).map((k) => [k, kind === "sections" ? 2.0 : 2.5]));
    const { page } = fakeSite(LIST, "https://vc.com/");
    const r = await runGoto(page, "which dev tools companies", { scorer: partial });
    expect(r.found).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.passages.length).toBe(3);
  });
  it("reports promising unvisited links when not found", async () => {
    const { page } = fakeSite(SITE, "https://acme.com/");
    const r = await runGoto(page, "audit logs", { scorer, maxSteps: 1 });
    expect(r.unvisited).toContain("https://acme.com/pricing");
  });
});

describe("browser_goto follows view-switch buttons, not action buttons", () => {
  it("clicks a tab-like button to reach the answer, skips action buttons", async () => {
    let view = "overview";
    const clicked: string[] = [];
    const page: GotoPage = {
      url: () => "http://localhost/app",
      goto: async () => {},
      settle: async () => {},
      click: async (sel) => { clicked.push(sel); if (sel.includes('"2"')) view = "gp"; },
      evaluate: async () => view === "overview"
        ? { blocks: [{ h: 1, t: "Overview" }, { h: 0, t: "Revenue summary" }],
            elements: [
              { ref: 1, kind: "button", text: "Delete plan" },
              { ref: 2, kind: "button", text: "Plan GP" },
              { ref: 3, kind: "button", text: "Save scenario" },
            ] }
        : { blocks: [{ h: 1, t: "Plan GP" }, { h: 0, t: "Cloud $30: gross margin 90.0%" }], elements: [] },
    };
    const scorer: ItemScorer = async (_g, kind, items) =>
      Object.fromEntries(Object.entries(items).map(([k, v]) => [k,
        kind === "sections" ? (String(v).includes("90.0%") ? 3 : 0.2) : 2.5]));
    const r = await runGoto(page, "gross margin for Cloud $30", { scorer });
    expect(r.found).toBe(true);
    expect(clicked).toEqual(['[data-pjid="2"]']);
  });
});
