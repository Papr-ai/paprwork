import { describe, expect, it } from "vitest";
import {
  PROMOTE_AT,
  createSeedStore,
  hashText,
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
