import { describe, expect, it } from "vitest";
import { normalizePreviewPaging, previewOrderBy } from "./dbPreviewPaging.js";

describe("normalizePreviewPaging", () => {
  it("passes valid values through", () => {
    expect(normalizePreviewPaging(100, 200)).toEqual({ limit: 100, offset: 200 });
  });
  it("defaults missing or garbage input", () => {
    expect(normalizePreviewPaging(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(normalizePreviewPaging("x", "y")).toEqual({ limit: 50, offset: 0 });
    expect(normalizePreviewPaging(0, -5)).toEqual({ limit: 50, offset: 0 });
  });
  it("caps the page size and floors fractions", () => {
    expect(normalizePreviewPaging(99999, 7.9)).toEqual({ limit: 500, offset: 7 });
  });
});

describe("previewOrderBy", () => {
  it("orders by primary key columns, quoting identifiers", () => {
    expect(previewOrderBy([{ name: 'a"b', pk: true }, { name: "c", pk: false }])).toBe(' ORDER BY "a""b"');
  });
  it("adds nothing when there is no primary key", () => {
    expect(previewOrderBy([{ name: "c", pk: false }])).toBe("");
  });
});
