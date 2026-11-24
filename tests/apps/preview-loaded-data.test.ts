import { beforeEach, describe, expect, it } from "vitest";
import {
  checkPreviewDataRendered,
  clearPreviewLoadedData,
  findRowArrays,
  recordPreviewBackendStdout,
  recordPreviewLoadedRows,
} from "../../src/gateway/utils/previewLoadedData.js";

const APP = "app-preview-data";
const window = () => [Date.now() - 5_000, Date.now() + 5_000] as const;

describe("previewLoadedData", () => {
  beforeEach(() => clearPreviewLoadedData());

  it("flags rows whose values are their column names (grocery-list bug)", () => {
    recordPreviewBackendStdout(APP, "items", JSON.stringify({ items: [
      { id: "id", name: "name", quantity: "quantity", checked: "checked" },
      { id: "id", name: "name", quantity: "quantity", checked: "checked" },
    ] }));
    const errs = checkPreviewDataRendered(APP, ...window(), "Grocery List\n0 items");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("backend/items");
    expect(errs[0]).toContain("column names");
  });

  it("flags loaded rows that never reach the screen", () => {
    recordPreviewLoadedRows(APP, "db/query grocery", [
      { id: 1, name: "Milk", note: "2%" },
      { id: 2, name: "Eggs", note: "dozen" },
    ]);
    const errs = checkPreviewDataRendered(APP, ...window(), "Grocery List\n\n\n<ul><li></li><li></li></ul>");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("none of their values appear on screen");
    expect(errs[0]).toContain('"Milk"');
  });

  it("passes when any loaded value is on screen (text, attribute or input value)", () => {
    recordPreviewLoadedRows(APP, "db/batch", [{ name: "Milk" }, { name: "Eggs" }]);
    expect(checkPreviewDataRendered(APP, ...window(), "MILK\n")).toEqual([]);
    expect(checkPreviewDataRendered(APP, ...window(), '<input value="Eggs">')).toEqual([]);
  });

  it("ignores ids, dates, urls, numbers, flags, and canvas charts", () => {
    recordPreviewLoadedRows(APP, "db/query x", [
      { id: "3f9a2c1d-aaaa-bbbb-cccc-1234567890ab", at: "2026-11-24T00:00:00Z", url: "https://x.y", n: 4, ok: "true" },
      { id: "4f9a2c1d-aaaa-bbbb-cccc-1234567890ab", at: "2026-11-25T00:00:00Z", url: "https://x.z", n: 5, ok: "false" },
    ]);
    expect(checkPreviewDataRendered(APP, ...window(), "Dashboard")).toEqual([]);
    clearPreviewLoadedData();
    recordPreviewLoadedRows(APP, "db/query x", [{ label: "January" }, { label: "February" }]);
    expect(checkPreviewDataRendered(APP, ...window(), "Sales <canvas></canvas>")).toEqual([]);
  });

  it("only counts data loaded during the preview window", () => {
    recordPreviewLoadedRows(APP, "db/query x", [{ name: "Milk" }, { name: "Eggs" }]);
    const later = Date.now() + 60_000;
    expect(checkPreviewDataRendered(APP, later, later + 1000, "nothing")).toEqual([]);
  });

  it("finds row arrays at the top level and one or two levels down", () => {
    expect(findRowArrays([{ a: 1 }])).toHaveLength(1);
    expect(findRowArrays({ items: [{ a: 1 }] })).toHaveLength(1);
    expect(findRowArrays({ data: { rows: [{ a: 1 }] } })).toHaveLength(1);
    expect(findRowArrays({ ok: true, count: 3 })).toHaveLength(0);
    expect(findRowArrays(["a", "b"])).toHaveLength(0);
  });
});
