import { describe, expect, it } from "vitest";
import {
  collectOpenItemsAcrossEntities,
  formatLastUpdated,
  formatUpdatedAt,
  groupOpenItemsByCategory,
  isIdentitySectionPlaceholder,
  parseChangelogEntries,
  parseDecisions,
  parseKeyDetailRows,
  parseOpenItems,
  parseWikiEntityRef,
  splitEntityMentions,
} from "../ui/utils/wikiSectionUtils";
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
});
