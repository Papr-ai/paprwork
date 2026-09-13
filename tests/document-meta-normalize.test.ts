import { describe, expect, it } from "vitest";
import {
  documentMetaNeedsRewrite,
  normalizeDocumentMeta,
} from "../src/gateway/services/documentMetaNormalize.js";

/**
 * The exact meta.json that produced the reported warning. It is favourited, so
 * it reaches the sidebar's favourites list, and it carries neither `id` nor
 * `type` — the cast in `readMeta` supplied `undefined` for both and the missing
 * id became a React list key.
 */
const SEEDED_META_WITHOUT_ID = {
  title: "My Document",
  tags: ["test", "migration"],
  favorite: true,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T12:00:00Z",
  preview: "This is my document.",
  wordCount: 6,
};

const OPTIONS = { fallbackTitle: "Doc 001" };

describe("normalizeDocumentMeta", () => {
  it("supplies the id the reported file was missing", () => {
    const meta = normalizeDocumentMeta("doc-001", SEEDED_META_WITHOUT_ID, OPTIONS);
    expect(meta?.id).toBe("doc-001");
    expect(meta?.type).toBe("document");
  });

  it("keeps every field the file did state", () => {
    // Repair must not cost data: the record is completed, not replaced.
    const meta = normalizeDocumentMeta("doc-001", SEEDED_META_WITHOUT_ID, OPTIONS);
    expect(meta).toMatchObject({
      title: "My Document",
      tags: ["test", "migration"],
      favorite: true,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T12:00:00Z",
      preview: "This is my document.",
      wordCount: 6,
    });
  });

  it("lets the directory name override a contradicting stored id", () => {
    // Every lookup path is built from the directory name, so a document is
    // reachable under it whatever the file claims. Trusting the file instead
    // would hand out an id that resolves to nothing.
    const meta = normalizeDocumentMeta(
      "actual-dir",
      { ...SEEDED_META_WITHOUT_ID, id: "stale-id" },
      OPTIONS,
    );
    expect(meta?.id).toBe("actual-dir");
  });

  it("falls back to the derived title when none is stored", () => {
    const meta = normalizeDocumentMeta("doc-001", { favorite: false }, OPTIONS);
    expect(meta?.title).toBe("Doc 001");
  });

  it("ignores fields of the wrong type rather than passing them through", () => {
    const meta = normalizeDocumentMeta(
      "doc-001",
      { title: 42, tags: "not-an-array", wordCount: "six", favorite: "yes" },
      OPTIONS,
    );
    expect(meta).toMatchObject({
      title: "Doc 001",
      tags: [],
      wordCount: 0,
      // Only a real boolean true counts; a truthy string must not favourite a
      // document, since that is what puts it in the sidebar.
      favorite: false,
    });
  });

  it("drops blank tag entries but keeps real ones", () => {
    const meta = normalizeDocumentMeta(
      "doc-001",
      { tags: ["real", 7, null, "also-real"] },
      OPTIONS,
    );
    expect(meta?.tags).toEqual(["real", "also-real"]);
  });

  it("defaults updatedAt to createdAt rather than to now", () => {
    const meta = normalizeDocumentMeta(
      "doc-001",
      { createdAt: "2025-01-01T00:00:00Z" },
      OPTIONS,
    );
    expect(meta?.updatedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("returns null for content that is not an object, so the caller rebuilds", () => {
    // Corruption, not an incomplete record — there is nothing here to complete,
    // and `readMeta` regenerates from content.md instead.
    expect(normalizeDocumentMeta("doc-001", "just a string", OPTIONS)).toBeNull();
    expect(normalizeDocumentMeta("doc-001", null, OPTIONS)).toBeNull();
    expect(normalizeDocumentMeta("doc-001", [1, 2], OPTIONS)).toBeNull();
  });
});

describe("documentMetaNeedsRewrite", () => {
  it("flags the reported file", () => {
    expect(documentMetaNeedsRewrite("doc-001", SEEDED_META_WITHOUT_ID)).toBe(true);
  });

  it("flags an id that disagrees with its directory", () => {
    expect(
      documentMetaNeedsRewrite("actual-dir", {
        ...SEEDED_META_WITHOUT_ID,
        id: "stale-id",
        type: "document",
      }),
    ).toBe(true);
  });

  it("leaves a healthy file alone", () => {
    // Guards against rewriting all ~288 documents on every launch.
    expect(
      documentMetaNeedsRewrite("doc-001", {
        ...SEEDED_META_WITHOUT_ID,
        id: "doc-001",
        type: "document",
      }),
    ).toBe(false);
  });

  it("does not flag a healthy file merely for omitting optional fields", () => {
    expect(
      documentMetaNeedsRewrite("doc-001", { id: "doc-001", type: "document" }),
    ).toBe(false);
  });
});
