/**
 * Model selection must not cross between chats.
 *
 * The bug these cover: per-chat selection lived only in an in-memory map, so a
 * restart emptied it and every chat then fell back to one global "last model
 * picked anywhere". Opening an Opus chat showed Fable — and, because the picker
 * value is what gets sent as `config.model`, Fable actually answered. In one
 * real chat, 32 turns ran on claude-opus-5 and 2 turns silently ran on Fable.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_REMEMBERED_CHATS,
  forgetChatModel,
  readChatModel,
  readNewChatDefaultModel,
  renameChatModel,
  writeChatModel,
  writeNewChatDefaultModel,
} from "../ui/utils/chatModelMemory";
import {
  findHistoryModelId,
  resolveChatModelId,
} from "../ui/utils/resolveChatModel";

/** Minimal localStorage so these run without a DOM. */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const OPUS = "claude-opus-5";
const FABLE = "claude-fable-5-1";

beforeEach(() => {
  const storage = new MemoryStorage();
  // @ts-expect-error -- test shim for a browser global
  globalThis.window = { localStorage: storage };
});

describe("chatModelMemory", () => {
  it("keeps each chat's model separate", () => {
    writeChatModel("chat-opus", OPUS);
    writeChatModel("chat-fable", FABLE);

    expect(readChatModel("chat-opus")).toBe(OPUS);
    expect(readChatModel("chat-fable")).toBe(FABLE);
  });

  it("regression: picking a model in one chat does not change another", () => {
    writeChatModel("chat-a", OPUS);
    writeChatModel("chat-b", OPUS);

    writeChatModel("chat-b", FABLE);

    expect(readChatModel("chat-a")).toBe(OPUS);
    expect(readChatModel("chat-b")).toBe(FABLE);
  });

  it("survives a restart — this is what the in-memory map could not do", () => {
    writeChatModel("chat-opus", OPUS);

    // A restart drops React/Zustand state but not localStorage.
    expect(readChatModel("chat-opus")).toBe(OPUS);
  });

  it("returns undefined for a chat it has never seen", () => {
    writeChatModel("chat-fable", FABLE);
    expect(readChatModel("chat-unknown")).toBeUndefined();
  });

  it("tracks the new-chat default separately from any chat", () => {
    writeChatModel("chat-opus", OPUS);
    writeNewChatDefaultModel(FABLE);

    expect(readNewChatDefaultModel()).toBe(FABLE);
    expect(readChatModel("chat-opus")).toBe(OPUS);
  });

  it("carries the selection across the temp -> permanent chat id rename", () => {
    writeChatModel("temp-123", FABLE);
    renameChatModel("temp-123", "real-456");

    expect(readChatModel("real-456")).toBe(FABLE);
    expect(readChatModel("temp-123")).toBeUndefined();
  });

  it("forgets a deleted chat", () => {
    writeChatModel("chat-gone", OPUS);
    forgetChatModel("chat-gone");
    expect(readChatModel("chat-gone")).toBeUndefined();
  });

  it("bounds growth, evicting least recently used chats first", () => {
    for (let i = 0; i < MAX_REMEMBERED_CHATS; i++) {
      writeChatModel(`chat-${i}`, OPUS);
    }
    // Revisit the oldest so it is no longer least-recently-used.
    writeChatModel("chat-0", FABLE);
    writeChatModel("chat-overflow", OPUS);

    expect(readChatModel("chat-0")).toBe(FABLE);
    expect(readChatModel("chat-overflow")).toBe(OPUS);
    expect(readChatModel("chat-1")).toBeUndefined();
  });

  it("shrugs off a corrupted blob instead of throwing", () => {
    window.localStorage.setItem("paprwork_chat_model_ids", "{not json");
    expect(readChatModel("chat-any")).toBeUndefined();

    writeChatModel("chat-any", OPUS);
    expect(readChatModel("chat-any")).toBe(OPUS);
  });

  it("ignores non-string entries in a tampered blob", () => {
    window.localStorage.setItem(
      "paprwork_chat_model_ids",
      JSON.stringify({ good: OPUS, bad: 42, empty: "" }),
    );
    expect(readChatModel("good")).toBe(OPUS);
    expect(readChatModel("bad")).toBeUndefined();
    expect(readChatModel("empty")).toBeUndefined();
  });

  it("does not throw when there is no window (SSR / worker)", () => {
    // @ts-expect-error -- removing the test shim
    delete globalThis.window;
    expect(() => writeChatModel("chat-a", OPUS)).not.toThrow();
    expect(readChatModel("chat-a")).toBeUndefined();
    expect(readNewChatDefaultModel()).toBeUndefined();
  });
});

describe("resolveChatModelId", () => {
  it("prefers the chat's own explicit selection", () => {
    expect(
      resolveChatModelId({
        perChatModelId: OPUS,
        historyModelId: FABLE,
        newChatDefaultModelId: FABLE,
        hasHistory: true,
      }),
    ).toBe(OPUS);
  });

  it("falls back to the model that answered in this chat", () => {
    expect(
      resolveChatModelId({
        historyModelId: OPUS,
        newChatDefaultModelId: FABLE,
        hasHistory: true,
      }),
    ).toBe(OPUS);
  });

  it("regression: an existing chat never inherits the global default", () => {
    // The exact reported case: an Opus chat, no local selection left after a
    // restart, and Fable was the last model picked in some other chat.
    expect(
      resolveChatModelId({
        newChatDefaultModelId: FABLE,
        hasHistory: true,
      }),
    ).toBeUndefined();
  });

  it("seeds a brand-new chat from the global default", () => {
    expect(
      resolveChatModelId({
        newChatDefaultModelId: FABLE,
        hasHistory: false,
      }),
    ).toBe(FABLE);
  });

  it("returns undefined when there is nothing to go on", () => {
    expect(resolveChatModelId({ hasHistory: false })).toBeUndefined();
  });

  it("keeps two parallel chats on their own models", () => {
    const opusChat = resolveChatModelId({
      perChatModelId: OPUS,
      newChatDefaultModelId: FABLE,
      hasHistory: true,
    });
    const fableChat = resolveChatModelId({
      perChatModelId: FABLE,
      newChatDefaultModelId: FABLE,
      hasHistory: true,
    });

    expect(opusChat).toBe(OPUS);
    expect(fableChat).toBe(FABLE);
  });
});

describe("findHistoryModelId", () => {
  it("returns the model that answered most recently", () => {
    expect(
      findHistoryModelId([
        { role: "user" },
        { role: "assistant", model: FABLE },
        { role: "user" },
        { role: "assistant", model: OPUS },
      ]),
    ).toBe(OPUS);
  });

  it("skips a streaming turn that has no model yet", () => {
    expect(
      findHistoryModelId([
        { role: "assistant", model: OPUS },
        { role: "user" },
        { role: "assistant" },
      ]),
    ).toBe(OPUS);
  });

  it("ignores user messages", () => {
    expect(
      findHistoryModelId([{ role: "user", model: FABLE }]),
    ).toBeUndefined();
  });

  it("returns undefined for an empty chat", () => {
    expect(findHistoryModelId([])).toBeUndefined();
  });
});
