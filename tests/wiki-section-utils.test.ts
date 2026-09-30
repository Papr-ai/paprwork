import { describe, expect, it } from "vitest";
import {canonicalSectionTitle,
  normalizeEntitySections,
  collectOpenItemsAcrossEntities,
  formatLastUpdated,
  formatUpdatedAt,
  formatWikiJobLastUpdated,
  groupOpenItemsByCategory,
  isIdentitySectionPlaceholder,
  parseChangelogEntries,
  parseDailyLogDate,
  parseDecisions,
  parseKeyDetailRows,
  parseOpenItems,
  parseWikiEntityRef,
  sortWikiNodesByUpdatedAt,
  splitEntityMentions,
  wikiNodeUpdatedAtMs, canonicalSectionTitle, normalizeEntitySections } from "../ui/utils/wikiSectionUtils";
import type { WikiNode } from "../ui/types/wiki";

describe("wikiSectionUtils", () => {
  it("formats recent updated_at values", () => {
    const today = new Date().toISOString();
    expect(formatUpdatedAt(today)).toBe("Updated today");
    expect(formatLastUpdated(today)).toBe("Last updated today");
  });

  it("parses open items with completion state and category tags", () => {
    const content = `- [ ] [user] Follow up with Acme
- [x] [agent] Fix sync pipeline
- [ ] Ship billing update`;
    expect(parseOpenItems(content)).toEqual([
      {
        completed: false,
        text: "Follow up with Acme",
        category: "user",
        rawLine: "- [ ] [user] Follow up with Acme",
        fileIndex: 0,
      },
      {
        completed: true,
        text: "Fix sync pipeline",
        category: "agent",
        rawLine: "- [x] [agent] Fix sync pipeline",
        fileIndex: 1,
      },
      {
        completed: false,
        text: "Ship billing update",
        category: "uncategorized",
        rawLine: "- [ ] Ship billing update",
        fileIndex: 2,
      },
    ]);
  });

  it("ignores stub open items from default entity templates", () => {
    const content = `- [ ] Enrich this entity with more context from memory and conversations`;
    expect(parseOpenItems(content)).toEqual([]);
  });

  it("parses changelog entries newest-first", () => {
    const content = `- 2026-08-28 — First update
- 2026-08-29 — Second update`;
    const entries = parseChangelogEntries(content);
    expect(entries[0]?.date).toBe("2026-08-29");
    expect(entries[1]?.date).toBe("2026-08-28");
  });

  it("parses wiki entity refs", () => {
    expect(parseWikiEntityRef("company/techstars")).toEqual({
      type: "company",
      id: "techstars",
      fullId: "company/techstars",
    });
  });

  it("splits entity mention links", () => {
    const segments = splitEntityMentions(
      "Talk to [[company/acme|Acme Corp]] tomorrow.",
    );
    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({
      kind: "entity",
      entityRef: "company/acme",
      entityLabel: "Acme Corp",
    });
  });

  it("collects open items across entities", () => {
    const nodes: WikiNode[] = [
      {
        id: "company/papr",
        type: "company",
        label: "Papr",
        description: "",
        props: { updated_at: "2026-08-29" },
        sections: {
          "Open Items":
            "- [ ] [user] Ship billing update\n- [x] Done item",
        },
      },
      {
        id: "person/jane",
        type: "person",
        label: "Jane",
        description: "",
        props: { updated_at: "2026-08-28" },
        sections: {
          "Open Items": "- [ ] Follow up on contract",
        },
      },
    ];
    const items = collectOpenItemsAcrossEntities(nodes);
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("Ship billing update");
    expect(items[0]?.category).toBe("user");
    expect(items[1]?.text).toBe("Follow up on contract");
    expect(items[1]?.category).toBe("uncategorized");
  });

  it("groups open items by write-time category", () => {
    const items = collectOpenItemsAcrossEntities([
      {
        id: "app/sync",
        type: "app",
        label: "Sync",
        description: "",
        props: {},
        sections: {
          "Open Items": "- [ ] [agent] Fix SQLite lock",
        },
      },
      {
        id: "person/jane",
        type: "person",
        label: "Jane",
        description: "",
        props: {},
        sections: {
          "Open Items": "- [ ] [user] Review contract",
        },
      },
    ]);
    const grouped = groupOpenItemsByCategory(items);
    expect(grouped.user).toHaveLength(1);
    expect(grouped.agent).toHaveLength(1);
    expect(grouped.papr).toHaveLength(0);
  });

  it("parses key details and hides internal media fields", () => {
    const rows = parseKeyDetailRows(`- status: active
- image: data:image/png;base64,abc
- hero_image: data:image/png;base64,def
- website: https://papr.ai`);
    expect(rows.map((row) => row.key)).toEqual(["status", "image", "website"]);
  });

  it("parses structured entity decisions", () => {
    const content = `- [open] Expand to enterprise — Owner: Amir — Evidence: Q3 planning chat
- [decided] Ship Memory redesign — Owner: Team — Evidence: User feedback 2026-08-20`;
    expect(parseDecisions(content)).toEqual([
      {
        status: "open",
        text: "Expand to enterprise",
        owner: "Amir",
        evidence: "Q3 planning chat",
        rawLine: "- [open] Expand to enterprise — Owner: Amir — Evidence: Q3 planning chat",
      },
      {
        status: "decided",
        text: "Ship Memory redesign",
        owner: "Team",
        evidence: "User feedback 2026-08-20",
        rawLine:
          "- [decided] Ship Memory redesign — Owner: Team — Evidence: User feedback 2026-08-20",
      },
    ]);
  });

  it("detects identity goals placeholder sections", () => {
    expect(
      isIdentitySectionPlaceholder(
        "Goals",
        "(What the user wants to accomplish with Paprwork)",
      ),
    ).toBe(true);
    expect(
      isIdentitySectionPlaceholder("Goals", "- Launch enterprise tier"),
    ).toBe(false);
  });

  it("parses daily log display names with memory/ prefix and labels", () => {
    expect(parseDailyLogDate("memory/2026-09-01.md (today)")).toBe("2026-09-01");
    expect(parseDailyLogDate("2026-08-30.md")).toBe("2026-08-30");
    expect(parseDailyLogDate("IDENTITY.md")).toBeNull();
  });

  it("formats wiki job last updated for the top bar", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatWikiJobLastUpdated(twoHoursAgo)).toBe(
      "Last updated at: 2 hours ago",
    );
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatWikiJobLastUpdated(threeDaysAgo)).toBe(
      "Last updated at: 3 days ago",
    );
  });

  it("sorts wiki nodes by updated_at descending", () => {
    const nodes: WikiNode[] = [
      {
        id: "project/old",
        type: "project",
        label: "Old",
        description: "",
        props: { updated_at: "2026-01-01" },
      },
      {
        id: "project/new",
        type: "project",
        label: "New",
        description: "",
        props: { updated_at: "2026-09-01" },
      },
    ];
    const sorted = sortWikiNodesByUpdatedAt(nodes);
    expect(sorted[0].label).toBe("New");
    expect(wikiNodeUpdatedAtMs(sorted[0])).toBeGreaterThan(
      wikiNodeUpdatedAtMs(sorted[1]),
    );
  });
});

describe("legacy section aliasing (Wiki Writer ≤v8 pages must still render)", () => {
  it("maps legacy headings onto canonical sections", () => {
    expect(canonicalSectionTitle("Overview")).toBe("Context & Background");
    expect(canonicalSectionTitle("Key Facts")).toBe("Key Details");
    expect(canonicalSectionTitle("Timeline")).toBe("Key Interactions");
    expect(canonicalSectionTitle("Sources")).toBe("Key Interactions");
    expect(canonicalSectionTitle("Related Entities")).toBe("Key Details");
    expect(canonicalSectionTitle("Update: July 14, 2026 — Cloud Deployment Unblocked")).toBe("Key Interactions");
    expect(canonicalSectionTitle("Key Interactions")).toBe("Key Interactions");
    expect(canonicalSectionTitle("The Bug")).toBeNull();
  });

  it("folds legacy sections into renderable ones without losing content", () => {
    const out = normalizeEntitySections({
      Overview: "Home is the daily-brief dashboard.",
      "Key Facts": "| Field | Value |\n|---|---|\n| App ID | abc |",
      Details: "### Root cause\nsave_brief.py used the wrong sourceId.",
      Timeline: "- **2026-09-01** — fixed",
      Sources: "- Daily log: memory/2026-09-01.md",
      "Open Items": "- [ ] [user] Confirm brief (G1)",
      "The Bug": "free-form heading nobody mapped",
    });
    expect(Object.keys(out).sort()).toEqual(
      ["Context & Background", "Key Details", "Key Interactions", "Open Items"].sort(),
    );
    expect(out["Context & Background"]).toContain("Home is the daily-brief dashboard.");
    expect(out["Context & Background"]).toContain("### The Bug");
    expect(out["Key Details"]).toContain("| App ID | abc |");
    expect(out["Key Interactions"]).toContain("### Details");
    expect(out["Key Interactions"]).toContain("### Timeline");
    expect(out["Key Interactions"]).toContain("### Sources");
    // Open Items is index-addressed for check-off writes — must be passed through untouched.
    expect(out["Open Items"]).toBe("- [ ] [user] Confirm brief (G1)");
  });

  it("never folds foreign content into Open Items", () => {
    const out = normalizeEntitySections({
      "Open Items": "- [ ] [user] a",
      Commitments: "- [ ] owed to user: MSA from Justin",
    });
    expect(out["Open Items"]).toBe("- [ ] [user] a");
    expect(out["Key Interactions"]).toContain("MSA from Justin");
  });

  it("canonical content stays first when a legacy section folds into it", () => {
    const out = normalizeEntitySections({
      "Key Interactions": "- **2026-09-04** — canonical entry",
      Timeline: "- **2026-07-27** — legacy entry",
    });
    expect(out["Key Interactions"].indexOf("canonical entry")).toBeLessThan(
      out["Key Interactions"].indexOf("legacy entry"),
    );
  });
});
