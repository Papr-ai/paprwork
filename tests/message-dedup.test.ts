import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../ui/types/chat";
import { dedupeChatMessages, userMessageDedupKey } from "../ui/utils/messageDedup";

function user(id: string, content: string): ChatMessage {
  return { id, role: "user", content };
}

describe("messageDedup", () => {
  it("builds a stable key for user messages", () => {
    expect(userMessageDedupKey(user("a", "hello"))).toBe("hello::");
  });

  it("drops optimistic user duplicates in favor of persisted ids", () => {
    const merged = dedupeChatMessages([
      user("msg-user-1700000000000", "First message"),
      user("server-uuid-1", "First message"),
      user("server-uuid-2", "Second message"),
    ]);

    expect(merged.map((message) => message.id)).toEqual([
      "server-uuid-1",
      "server-uuid-2",
    ]);
  });

  it("dedupes pagination overlap when server copy is prepended", () => {
    const shared = "First message in chat";
    const merged = dedupeChatMessages([
      user("server-uuid-1", shared),
      user("msg-user-1700000000000", shared),
      user("server-uuid-2", "Second message"),
    ]);

    expect(merged.map((message) => message.id)).toEqual([
      "server-uuid-1",
      "server-uuid-2",
    ]);
  });

  it("keeps assistant messages even when content repeats", () => {
    const merged = dedupeChatMessages([
      { id: "a1", role: "assistant", content: "Done." },
      { id: "a2", role: "assistant", content: "Done." },
    ]);

    expect(merged).toHaveLength(2);
  });
});
