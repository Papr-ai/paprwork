import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { expect, test, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "focus-display-"));
vi.mock("../../src/core/utils/paprRoot.js", () => ({ getPaprWorkspaceDir: () => path.join(root, "workspace") }));

import { cleanDisplay, readMetrics, recordMetrics } from "../../src/gateway/services/focusTrackers.js";

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
