import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { expect, test, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "focus-display-"));
vi.mock("../src/core/utils/paprRoot.js", () => ({ getPaprWorkspaceDir: () => path.join(root, "workspace") }));

import { cleanDisplay, readMetrics, recordMetrics } from "../src/gateway/services/focusTrackers.js";

test("cleanDisplay keeps the known shape and drops the rest", () => {
  const d = cleanDisplay({
    label: "  points better than baseline  ", format: "pts", line: "x".repeat(300), evil: "<script>",
    chart: { caption: "Spend vs credits", target: 3000, bars: [
      { label: "M", value: 1200, tone: "full" }, { label: "", value: 5 }, { label: "T", value: Number.NaN },
      { label: "W", value: 900, tone: "purple" }, ...Array.from({ length: 30 }, (_, i) => ({ label: String(i % 10), value: i })),
    ] },
  });
  expect(d?.label).toBe("points better than baseline");
  expect(d?.format).toBe("pts");
  expect(d?.line).toHaveLength(120);
  expect((d as Record<string, unknown>).evil).toBeUndefined();
  expect(d?.chart?.bars).toHaveLength(14); // up to 14 valid bars kept; blank label and NaN value dropped
  expect(d?.chart?.bars[1]).toEqual({ label: "W", value: 900 }); // unknown tone dropped, bar kept
  expect(d?.chart?.target).toBe(3000);
});

test("cleanDisplay is undefined for junk, and a chart needs a caption", () => {
  expect(cleanDisplay(null)).toBeUndefined();
  expect(cleanDisplay("x")).toBeUndefined();
  expect(cleanDisplay({ format: "euros" })).toBeUndefined();
  expect(cleanDisplay({ chart: { bars: [{ label: "M", value: 1 }] } })).toBeUndefined();
});

test("recordMetrics stores display and item value/unit; a later post without display clears it", async () => {
  await recordMetrics({
    goalId: "G6", summary: { quality_pts: 0.6 }, display: { label: "points vs baseline", format: "pts" },
    items: [{ source: "coir", text: "SciFact", value: 1.6, unit: "pts" }],
  });
  const a = await readMetrics("G6");
  expect(a?.display).toEqual({ label: "points vs baseline", format: "pts" });
  expect(a?.items?.[0]).toMatchObject({ value: 1.6, unit: "pts" });
  await recordMetrics({ goalId: "G6", summary: { quality_pts: 0.7 } });
  expect((await readMetrics("G6"))?.display).toBeUndefined();
});

// The renderer is a browser script. Run the real file against tiny stand-ins for its two helpers.
const load = () => {
  const src = readFileSync("src/resources/default-apps/home-dashboard/three_hero.js", "utf8");
  const Three = {
    esc: (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
    hours: (h: number) => `${h}h`,
  };
  const ThreeTrack = { num: (n: number) => n.toLocaleString("en-US"), ago: () => "now" };
  return new Function("Three", "ThreeTrack", `${src}; return ThreeHero;`)(Three, ThreeTrack);
};

const goal = (metrics: Record<string, unknown>) => ({ id: "G", signals: { hours7: 9 }, tracker: { status: "active", metrics } });

test("a social goal renders exactly as before (no display)", () => {
  const html = load().html(goal({
    updatedAt: "", hero: "impressions7", summary: { impressions7: 86872, posts7: 10 },
    labels: { impressions7: "Views this week", posts7: "Posts this week" }, sources: {},
    items: [{ source: "x", at: new Date().toISOString(), impressions: 42468, text: "post" }],
  }));
  expect(html).toContain("86,872");
  expect(html).toContain("Views this week");
  expect(html).toContain("of 7 days");
  expect(html).toContain("<span>views</span>");
});

test("a custom goal uses its own label, format, line, chart and tile unit", () => {
  const html = load().html(goal({
    updatedAt: "", hero: "quality_pts", summary: { quality_pts: 0.6 }, labels: {}, sources: {},
    display: {
      label: "points better than baseline", format: "pts", line: "v72 is 41% trained · $676 spent",
      chart: { caption: "<b>3 of 5</b> sets beat baseline", target: 0, bars: [{ label: "S", value: 2.1, tone: "full" }, { label: "C", value: 0.1, tone: "part" }] },
    },
    items: [{ source: "coir", text: "SciFact", value: 2.15, unit: "pts" }],
  }));
  expect(html).toContain("+0.6");
  expect(html).toContain("points better than baseline");
  expect(html).toContain("v72 is 41% trained");
  expect(html).toContain("&lt;b&gt;3 of 5"); // chart caption is escaped
  expect(html).toContain("is-full");
  expect(html).toContain("+2.2<span>pts</span>"); // 2.15 rounds half up to one decimal
  expect(html).not.toContain("of 7 days");
  expect(html).not.toContain("vs last week"); // a delta of a delta is meaningless
});

test("usd and percent heroes format", () => {
  const h = load();
  expect(h.fmt(51375.4, "usd")).toBe("$51,375");
  expect(h.fmt(41.6, "percent")).toBe("42%");
  expect(h.fmt(7, undefined)).toBe("7");
});
