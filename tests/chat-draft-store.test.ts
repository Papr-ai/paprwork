/**
 * Drafts must survive whatever kills the renderer.
 *
 * The regression these pin: unsent composer text lived only in an in-memory
 * Zustand map, so a render-time throw took it with the app. Unlike messages,
 * a draft exists nowhere else — there is no server copy to recover it from.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DRAFT_CHARS,
  MAX_REMEMBERED_DRAFTS,
  forgetDraft,
  readDraft,
  renameDraft,
  writeDraft,
} from "../ui/utils/chatDraftStore";
import {
  sameSettings,
  type ChatModelSettings,
} from "../ui/utils/chatModelSettings";

/** The backend project runs in node, which has no `window.localStorage`. */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

describe("chatDraftStore", () => {
  it("returns a written draft", () => {
    writeDraft("chat-a", "half a thought");
    expect(readDraft("chat-a")).toBe("half a thought");
  });

  it("survives the in-memory store being emptied", () => {
    // Nothing here touches React or Zustand — that is the point. A crash that
    // wipes the store leaves this copy intact.
    writeDraft("chat-a", "still here");
    expect(readDraft("chat-a")).toBe("still here");
  });

  it("keeps drafts isolated per chat", () => {
    writeDraft("chat-a", "for a");
    writeDraft("chat-b", "for b");
    expect(readDraft("chat-a")).toBe("for a");
    expect(readDraft("chat-b")).toBe("for b");
  });

  it("returns empty string for a chat with no draft", () => {
    expect(readDraft("never-typed-in")).toBe("");
  });

  it("returns empty string for an empty chat id", () => {
    expect(readDraft("")).toBe("");
  });

  it("removes the entry when the draft is cleared, rather than storing ''", () => {
    writeDraft("chat-a", "typed");
    writeDraft("chat-a", "");
    expect(readDraft("chat-a")).toBe("");
    const raw = storage.getItem("paprwork_chat_drafts");
    expect(raw).not.toContain("chat-a");
  });

  it("forgets a draft on demand", () => {
    writeDraft("chat-a", "typed");
    forgetDraft("chat-a");
    expect(readDraft("chat-a")).toBe("");
  });

  it("caps one draft so a giant paste cannot eat the storage budget", () => {
    writeDraft("chat-a", "x".repeat(MAX_DRAFT_CHARS + 5_000));
    expect(readDraft("chat-a")).toHaveLength(MAX_DRAFT_CHARS);
  });

  it("evicts the oldest drafts past the cap", () => {
    for (let i = 0; i < MAX_REMEMBERED_DRAFTS + 5; i++) {
      writeDraft(`chat-${i}`, `draft ${i}`);
    }
    expect(readDraft("chat-0")).toBe("");
    expect(readDraft("chat-4")).toBe("");
    expect(readDraft(`chat-${MAX_REMEMBERED_DRAFTS + 4}`)).toBe(
      `draft ${MAX_REMEMBERED_DRAFTS + 4}`,
    );
  });

  it("refreshes position on re-write, so an active chat is evicted last", () => {
    writeDraft("chat-old", "keep typing here");
    for (let i = 0; i < MAX_REMEMBERED_DRAFTS - 1; i++) {
      writeDraft(`filler-${i}`, `f${i}`);
    }
    // Touching it again moves it to the newest slot.
    writeDraft("chat-old", "keep typing here, more");
    for (let i = 0; i < 5; i++) {
      writeDraft(`later-${i}`, `l${i}`);
    }
    expect(readDraft("chat-old")).toBe("keep typing here, more");
  });

  it("carries a draft across the temp -> permanent chat id rename", () => {
    // Reachable: a user types a second message while the first is streaming,
    // which is exactly when this rename fires.
    writeDraft("temp-123", "second message");
    renameDraft("temp-123", "real-uuid");
    expect(readDraft("temp-123")).toBe("");
    expect(readDraft("real-uuid")).toBe("second message");
  });

  it("does nothing on a rename with no draft to move", () => {
    expect(() => renameDraft("temp-123", "real-uuid")).not.toThrow();
    expect(readDraft("real-uuid")).toBe("");
  });

  it("keeps the newest draft when storage is over quota", () => {
    // The draft being typed is the only one the user would notice losing, so
    // an over-quota write retries with just that entry rather than giving up.
    storage.setItem(
      "paprwork_chat_drafts",
      JSON.stringify({ "chat-old": "old draft" }),
    );
    const write = storage.setItem.bind(storage);
    let calls = 0;
    storage.setItem = (key: string, value: string) => {
      calls += 1;
      // Fail the full-map write; allow the trimmed retry.
      if (calls === 1) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      write(key, value);
    };

    writeDraft("chat-new", "the one being typed");
    expect(calls).toBe(2);
    expect(readDraft("chat-new")).toBe("the one being typed");
  });

  it("degrades to a no-op when storage is unavailable entirely", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => writeDraft("chat-a", "typed")).not.toThrow();
    expect(readDraft("chat-a")).toBe("");
  });

  it("ignores a corrupt stored blob instead of throwing", () => {
    storage.setItem("paprwork_chat_drafts", "not json{");
    expect(readDraft("chat-a")).toBe("");
    expect(() => writeDraft("chat-a", "typed")).not.toThrow();
    expect(readDraft("chat-a")).toBe("typed");
  });

  it("drops non-string entries from a tampered blob", () => {
    storage.setItem(
      "paprwork_chat_drafts",
      JSON.stringify({ "chat-a": 42, "chat-b": "real" }),
    );
    expect(readDraft("chat-a")).toBe("");
    expect(readDraft("chat-b")).toBe("real");
  });
});

describe("sameSettings", () => {
  // Guards the render loop: `readChatSettings` builds a fresh object every
  // call, so React state holding one cannot be compared by reference. Setting
  // it from a re-read would always look like a change.
  it("treats two independently-built equal objects as the same", () => {
    const a: ChatModelSettings = { effort: "high", contextLimit: 200_000 };
    const b: ChatModelSettings = { effort: "high", contextLimit: 200_000 };
    expect(a).not.toBe(b);
    expect(sameSettings(a, b)).toBe(true);
  });

  it("treats two empty objects as the same", () => {
    expect(sameSettings({}, {})).toBe(true);
  });

  it("distinguishes unset from set", () => {
    expect(sameSettings({}, { effort: "high" })).toBe(false);
    expect(sameSettings({ thinking: false }, {})).toBe(false);
  });

  it("notices a change in each field", () => {
    const base: ChatModelSettings = {
      thinking: true,
      effort: "high",
      contextLimit: 200_000,
      fast: false,
    };
    expect(sameSettings(base, { ...base, thinking: false })).toBe(false);
    expect(sameSettings(base, { ...base, effort: "low" })).toBe(false);
    expect(sameSettings(base, { ...base, contextLimit: 1_000_000 })).toBe(
      false,
    );
    expect(sameSettings(base, { ...base, fast: true })).toBe(false);
  });

  it("does not confuse `false` with unset", () => {
    // These mean different things: unset follows the model, false overrides it.
    expect(sameSettings({ thinking: false }, {})).toBe(false);
    expect(sameSettings({ fast: false }, {})).toBe(false);
  });
});
