import { describe, expect, it } from "vitest";
import {
  PROMOTE_AT,
  createSeedStore,
  hashText,
  interpretJevPick,
  itemText,
  needsCategorizing,
  normalizeCategoryName,
  promotePending,
  visibleCategory,
} from "../src/core/utils/appCategories";

const item = { key: "app:1", title: "LinkedIn Outreach", description: "Send sequences" };

describe("app categories rules", () => {
  it("seeds broad live categories", () => {
    const s = createSeedStore();
    expect(s.categories.every((c) => c.status === "live")).toBe(true);
    expect(s.categories.map((c) => c.name)).toContain("Sales");
  });

  it("re-runs on text change, on list change for Other, never for user picks", () => {
    const s = createSeedStore();
    expect(needsCategorizing(s, item)).toBe(true);
    s.assignments[item.key] = {
      category: null, confidence: 0, source: "jev",
      hash: hashText(itemText(item)), listVersion: s.version, at: "",
    };
    expect(needsCategorizing(s, item)).toBe(false);
    s.version += 1;
    expect(needsCategorizing(s, item)).toBe(true);
    s.assignments[item.key].source = "user";
    expect(needsCategorizing(s, { ...item, description: "changed" })).toBe(false);
  });

  it("keeps LLM names broad: 1–2 words, Title Case", () => {
    expect(normalizeCategoryName("legal & compliance stuff")).toBe("Legal & Compliance");
    expect(normalizeCategoryName("health and fitness")).toBe("Health & Fitness");
    expect(normalizeCategoryName("LinkedIn outreach automation")).toBe("Linkedin Outreach");
    expect(normalizeCategoryName("legal &")).toBe("Legal");
    expect(normalizeCategoryName("education")).toBe("Education");
    expect(normalizeCategoryName("  ")).toBeNull();
  });

  it("pending shows as Other until it has enough apps", () => {
    const s = createSeedStore();
    s.categories.push({ name: "Legal", definition: "Law", status: "pending", source: "llm", createdAt: "" });
    for (let i = 0; i < PROMOTE_AT; i++) {
      s.assignments[`app:${i}`] = {
        category: "Legal", confidence: 0.5, source: "llm", hash: "", listVersion: 1, at: "",
      };
      expect(visibleCategory(s, `app:${i}`)).toBeNull();
    }
    const v = s.version;
    expect(promotePending(s)).toEqual(["Legal"]);
    expect(s.version).toBe(v + 1);
    expect(visibleCategory(s, "app:0")).toBe("Legal");
  });
});

describe("new app prompt", () => {
  it("includes schedule and connections only when chosen", async () => {
    const { buildCreateAppPrompt } = await import("../ui/components/Apps/CreateAppModal");
    const plain = buildCreateAppPrompt({ goal: "Track expenses", cadence: "off", connections: [] });
    expect(plain).toContain("Build me a mini-app: Track expenses");
    expect(plain).not.toMatch(/scheduled job|connects to/);
    const full = buildCreateAppPrompt({ goal: "Lead digest", cadence: "daily", connections: ["Gmail", "HubSpot"] });
    expect(full).toContain("run on its own daily");
    expect(full).toContain("Gmail, HubSpot");
  });
});

describe("interpreting Jev picks", () => {
  const N = "None of these";
  it("takes a confident pick", () => {
    expect(interpretJevPick({ probabilities: { Sales: 0.92, Marketing: 0.08, [N]: 0 } }, N))
      .toEqual({ kind: "accept", category: "Sales", confidence: 0.92 });
  });
  it("takes the top pick when Jev is split but something fits (Delaware tax)", () => {
    expect(interpretJevPick({ probabilities: { Operations: 0.5, Finance: 0.49, [N]: 0.01 } }, N).kind).toBe("accept");
  });
  it("asks for a new category only when nothing fits", () => {
    expect(interpretJevPick({ probabilities: { Engineering: 0.32, Support: 0.13, [N]: 0.43 } }, N).kind).toBe("propose");
  });
  it("leaves it as Other when unsure either way", () => {
    expect(interpretJevPick({ probabilities: { Research: 0.45, Marketing: 0.3, [N]: 0.25 } }, N).kind).toBe("other");
  });
});

describe("new app starters come from the user's library", () => {
  it("leads with their most-used apps, then their top categories", async () => {
    const { buildCreateAppStarters } = await import("../ui/utils/createAppStarters");
    const apps = [
      { id: "a", title: "Reddit Research Agent", description: "Watches Reddit for pain points.", openCount: 40 },
      { id: "b", title: "Reddit Research Agent_2", openCount: 30 },
      { id: "c", title: "SEO Audit", openCount: 20 },
      { id: "d", title: "LinkedIn Outreach", openCount: 1 },
      { id: "e", title: "a3f9c1e2-77b0-4c1e-9d2a", openCount: 99 },
    ];
    const byKey = { "app:a": "Research", "app:b": "Research", "app:c": "Marketing", "app:d": "Sales" };
    const s = buildCreateAppStarters(apps, byKey);
    expect(s.map((x) => x.label)).toEqual([
      "Like Reddit Research Agent", "Like SEO Audit", "Topic monitor", "Content repurposer", "Follow-up reminders",
    ]);
    expect(s[0].prompt).toBe('An app like my "Reddit Research Agent" (Watches Reddit for pain points), but for ');
    expect(buildCreateAppStarters([], {})).toHaveLength(5);
  });
});

describe("categorizing happens in the background", () => {
  it("background categorize is a no-op under tests (never blocks create/update)", async () => {
    const { AppCategoryService } = await import("../src/gateway/services/AppCategoryService");
    const svc = new AppCategoryService();
    expect(() => svc.categorizeAppInBackground({ id: "x", title: "Anything" })).not.toThrow();
  });
});
