import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  documentSourceKey,
  hashDocumentContent,
  syncDocumentToPost,
} from "../src/gateway/services/documentPostSync.js";
import {
  cancelDocumentPostSync,
  pendingDocumentSyncCount,
  scheduleDocumentPostSync,
} from "../src/gateway/services/documentPostScheduler.js";

/**
 * Documents → Parse Post → Papr Memory.
 *
 * The similarity gate, memory write and PageVersion snapshot all live in
 * Parse Server and were verified live (probe 2026-09-15: trivial edit
 * suppressed 1→1 memories, major rewrite wrote 1→2). These tests cover only
 * paprwork's half: identity, the local no-op, and the request payload.
 */

const LONG = "x".repeat(200);

describe("document source key + hash", () => {
  test("source key is stable and namespaced per document", () => {
    expect(documentSourceKey("my-doc")).toBe("document:my-doc");
  });

  test("hash is content-derived and stable", () => {
    expect(hashDocumentContent("abc")).toBe(hashDocumentContent("abc"));
    expect(hashDocumentContent("abc")).not.toBe(hashDocumentContent("abd"));
  });
});

describe("syncDocumentToPost guards", () => {
  test("skips documents too short to be worth a memory", async () => {
    const result = await syncDocumentToPost({
      documentId: "tiny",
      title: "Tiny",
      content: "too short",
    });
    expect(result.reason).toBe("too_short");
    expect(result.synced).toBe(false);
  });

  test("treats whitespace-only content as too short", async () => {
    const result = await syncDocumentToPost({
      documentId: "blank",
      title: "Blank",
      content: "   \n\n   ",
    });
    expect(result.reason).toBe("too_short");
  });

  test("never throws — a document save must not fail on sync error", async () => {
    await expect(
      syncDocumentToPost({
        documentId: "doc",
        title: "Doc",
        content: LONG,
      }),
    ).resolves.toBeDefined();
  });
});

describe("debounce scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a typing burst collapses to ONE pending sync", () => {
    // THE POINT: an editor fires updateDocument on nearly every keystroke.
    // Without collapsing, each one is an HTTPS round-trip.
    for (let i = 0; i < 50; i++) {
      scheduleDocumentPostSync({
        documentId: "burst-doc",
        title: "Burst",
        content: `${LONG}${i}`,
      });
    }
    expect(pendingDocumentSyncCount()).toBe(1);
    cancelDocumentPostSync("burst-doc");
  });

  test("distinct documents queue independently", () => {
    scheduleDocumentPostSync({ documentId: "a", title: "A", content: LONG });
    scheduleDocumentPostSync({ documentId: "b", title: "B", content: LONG });
    expect(pendingDocumentSyncCount()).toBe(2);
    cancelDocumentPostSync("a");
    cancelDocumentPostSync("b");
  });

  test("cancel removes pending work — deleted docs must not sync", () => {
    scheduleDocumentPostSync({ documentId: "gone", title: "G", content: LONG });
    expect(pendingDocumentSyncCount()).toBe(1);
    cancelDocumentPostSync("gone");
    expect(pendingDocumentSyncCount()).toBe(0);
  });

  test("cancelling an unknown document is a no-op, not an error", () => {
    expect(() => cancelDocumentPostSync("never-queued")).not.toThrow();
  });

  test("nothing fires before the idle window elapses", () => {
    scheduleDocumentPostSync({ documentId: "wait", title: "W", content: LONG });
    vi.advanceTimersByTime(29_000);
    expect(pendingDocumentSyncCount()).toBe(1);
    cancelDocumentPostSync("wait");
  });

  test("the timer clears itself once the window elapses", () => {
    scheduleDocumentPostSync({ documentId: "fire", title: "F", content: LONG });
    vi.advanceTimersByTime(31_000);
    expect(pendingDocumentSyncCount()).toBe(0);
  });

  test("re-editing during the window restarts the countdown", () => {
    scheduleDocumentPostSync({ documentId: "ext", title: "E", content: LONG });
    vi.advanceTimersByTime(25_000);
    scheduleDocumentPostSync({ documentId: "ext", title: "E", content: LONG });
    vi.advanceTimersByTime(25_000); // 50s total, but only 25s since last edit
    expect(pendingDocumentSyncCount()).toBe(1);
    cancelDocumentPostSync("ext");
  });
});
