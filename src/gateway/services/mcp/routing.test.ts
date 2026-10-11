import { describe, expect, it } from "vitest";
import { parseClaudeAppConfig } from "./cardContract.js";
import { buildInstructions, lintRouting, looksStuffed, MAX_INSTRUCTION_APPS, routingLead } from "./routing.js";
import { planAppTools } from "./appTools.js";
import type { ClaudeApp } from "./catalog.js";

const cfg = (claude: Record<string, unknown>) =>
  parseClaudeAppConfig({ claude: { enabled: true, views: { status: { kind: "status", from: "s" } }, ...claude } })!;

const app = (slug: string, cards: Partial<ClaudeApp["cards"]> = {}, name?: string): ClaudeApp => ({
  appId: slug,
  namespaceId: "ns1",
  slug,
  name,
  cards: { version: 1, views: { status: { kind: "status", from: "s", file: "status.html", bytes: 1 } }, ...cards },
});

describe("metadata.claude routing fields", () => {
  it("parses whenToUse and examples at app and view level", () => {
    const c = parseClaudeAppConfig({
      claude: {
        enabled: true,
        whenToUse: "the user wants to find leads on LinkedIn",
        examples: ["help me run LinkedIn outreach"],
        views: { draft: { kind: "action", action: "d", whenToUse: "drafting a DM", examples: ["draft a DM to Ana"] } },
      },
    })!;
    expect(c.whenToUse).toBe("the user wants to find leads on LinkedIn");
    expect(c.views.draft.examples).toEqual(["draft a DM to Ana"]);
  });

  it("rejects bad shapes with author-facing messages", () => {
    expect(() => cfg({ examples: "one" })).toThrow(/list of strings/);
    expect(() => cfg({ examples: Array(7).fill("x") })).toThrow(/6 examples or fewer/);
    expect(() => cfg({ whenToUse: "x".repeat(281) })).toThrow(/longer than 280/);
  });
});

describe("lintRouting", () => {
  const errors = (c: Record<string, unknown>) => lintRouting(cfg(c)).filter((i) => i.severity === "error").map((i) => i.message);

  it("passes a specific, plain description", () => {
    expect(
      lintRouting(cfg({ whenToUse: "the user wants to find leads on LinkedIn or draft outreach messages", examples: ["help me run LinkedIn outreach"] })),
    ).toEqual([]);
  });

  it("blocks over-broad text that would fire on everything", () => {
    for (const w of ["Use for any task the user has", "Always use this for help", "helps with anything productivity", "use this first for all questions"]) {
      expect(errors({ whenToUse: w, examples: ["x y z"] })[0]).toMatch(/too broad/);
    }
    expect(errors({ whenToUse: "the user wants LinkedIn leads", examples: ["do anything for me"] })[0]).toMatch(/too broad/);
  });

  it("blocks keyword stuffing", () => {
    expect(looksStuffed("linkedin, outreach, leads, sales, crm, prospecting, dm, email, growth, b2b")).toBe(true);
    expect(looksStuffed("outreach outreach outreach outreach for linkedin")).toBe(true);
    expect(looksStuffed("the user wants to find leads on LinkedIn, draft DMs, or check replies")).toBe(false);
    expect(errors({ whenToUse: "linkedin, outreach, leads, sales, crm, prospecting, dm, email, growth, b2b" })[0]).toMatch(/keyword list/);
  });

  it("warns (never blocks) on missing, short, duplicated or too many views", () => {
    const warns = lintRouting(
      parseClaudeAppConfig({
        claude: {
          enabled: true,
          whenToUse: "leads",
          views: {
            a: { kind: "status", from: "s", examples: ["same ask"] },
            b: { kind: "status", from: "s", examples: ["Same ask"] },
            c: { kind: "status", from: "s" },
            d: { kind: "status", from: "s" },
          },
        },
      })!,
    );
    expect(warns.every((w) => w.severity === "warning")).toBe(true);
    const text = warns.map((w) => w.message).join("\n");
    for (const re of [/too short/, /claude\.examples/, /more than one view/, /first 3 views/]) expect(text).toMatch(re);
  });
});

describe("intent-first descriptions", () => {
  it("leads with when-to-use and quoted examples, view overriding app", () => {
    const a = app("outreach", { whenToUse: "Use when the user wants LinkedIn leads.", examples: ["find me leads", "run outreach"] });
    expect(routingLead("Outreach", a, {})).toBe('Papr · Outreach. Use when the user wants LinkedIn leads. E.g. "find me leads", "run outreach".');
    expect(routingLead("Outreach", a, { whenToUse: "drafting a DM", examples: ["draft a DM"] })).toBe(
      'Papr · Outreach. Use when drafting a DM. E.g. "draft a DM".',
    );
    expect(routingLead("Outreach", app("x"), {})).toBe("Papr · Outreach.");
  });

  it("puts the app's whenToUse on the primary view only, so sibling tools differ", () => {
    const views = {
      status: { kind: "status" as const, from: "s", file: "status.html", bytes: 1 },
      send: { kind: "approval" as const, action: "x", file: "send.html", bytes: 1 },
      draft: { kind: "action" as const, action: "d", file: "draft.html", bytes: 1, whenToUse: "the user wants a DM written" },
    };
    const [status, send, draft] = planAppTools([app("crm", { whenToUse: "the user wants LinkedIn leads", views }, "CRM")]);
    expect(status.description).toMatch(/^Papr · CRM\. Use when the user wants LinkedIn leads\./);
    expect(send.description).not.toMatch(/LinkedIn leads/);
    expect(draft.description).toMatch(/^Papr · CRM\. Use when the user wants a DM written\./);
  });

  it("caps each app at 3 tools in author order", () => {
    const views = Object.fromEntries(["a", "b", "c", "d"].map((v) => [v, { kind: "status" as const, from: "s", file: `${v}.html`, bytes: 1 }]));
    expect(planAppTools([app("crm", { views })]).map((t) => t.view)).toEqual(["a", "b", "c"]);
  });
});

describe("server instructions", () => {
  it("names the user's apps by intent, capped", () => {
    const apps = Array.from({ length: 18 }, (_, i) => app(`a${i}`, { whenToUse: `the user wants job ${i}` }, `App ${i}`));
    const text = buildInstructions("BASE", apps, (a) => a.name!);
    expect(text.startsWith("BASE\n\nThis user already runs these in Papr.")).toBe(true);
    expect(text).toContain("- App 0: the user wants job 0");
    expect(text.split("\n- ").length - 1).toBe(MAX_INSTRUCTION_APPS);
    expect(text).toContain("(+3 more; use papr_list_apps)");
    expect(buildInstructions("BASE", [], () => "")).toBe("BASE");
  });
});
