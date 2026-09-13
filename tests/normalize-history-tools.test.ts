import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../ui/types/chat";
import { normalizeLoadedMessage } from "../ui/utils/normalizeHistoryTools";

describe("normalizeLoadedMessage", () => {
  it("settles calling sequence tools that already have output", () => {
    const message: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      sequence: [
        {
          type: "tool",
          data: {
            name: "delegate_task",
            status: "calling",
            output: { id: "del-1", task: "Architect", status: "completed" },
          },
        },
      ],
    };

    const normalized = normalizeLoadedMessage(message);
    expect(
      (normalized.sequence?.[0]?.data as { status?: string }).status,
    ).toBe("success");
  });

  it("marks calling tools without output as interrupted", () => {
    const message: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "",
      sequence: [{ type: "tool", data: { name: "bash", status: "calling" } }],
    };

    const normalized = normalizeLoadedMessage(message);
    expect(
      (normalized.sequence?.[0]?.data as { status?: string }).status,
    ).toBe("interrupted");
  });
});
