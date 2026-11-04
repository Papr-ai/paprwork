import { describe, expect, it } from "vitest";
import { briefDates, briefFor, hashId, pickFocus, reviewMap } from "../../ui/components/Focus/page/brief";

const brief = (title: string) => JSON.stringify({
  hero: { title, date: "Mon" },
  sections: [{ type: "priorities", title: "Today's Priorities", items: [{ rank: 1, title: "A" }, { rank: 2, title: "B" }] }],
});
const now = new Date("2026-11-04T09:00:00");

describe("Focus brief model", () => {
  it("uses the Home app's item hash so old reviews still match", () => {
    const id = hashId(`2026-11-04|priorities|Today's Priorities|${JSON.stringify({ rank: 1, title: "A" })}`);
    const rows = [{ date: "2026-11-04", brief_json: brief("Today") }];
    const b = briefFor(rows, reviewMap([{ item_key: id, status: "complete", note: null, updated_at: "" }]), undefined, now)!;
    const pri = b.sections.find((s) => s.type === "priorities")!;
    expect(pri.items!.map((i) => i.title)).toEqual(["B"]);
    expect(b.sections.at(-1)!.type).toBe("reviewed");
  });

  it("falls back to the latest brief, marked stale, and skips broken rows", () => {
    const rows = [{ date: "2026-11-03", brief_json: "{}" }, { date: "2026-11-02", brief_json: brief("Sun") }];
    const b = briefFor(rows, {}, undefined, now)!;
    expect(b.date).toBe("2026-11-02");
    expect(b.stale).toBe(true);
    expect(briefDates(rows)).toEqual(["2026-11-02"]);
    expect(briefFor([], {}, undefined, now)).toBeNull();
  });

  it("lifts the top priority into Do this first and keeps the rest as Up next", () => {
    const b = briefFor([{ date: "2026-11-04", brief_json: brief("T") }], {}, undefined, now)!;
    const { focus, sections } = pickFocus(b.sections);
    expect(focus?.title).toBe("A");
    expect(sections[0].title).toBe("Up next");
  });
});
