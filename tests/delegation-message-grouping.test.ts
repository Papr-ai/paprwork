import { describe, expect, test } from "vitest";
import { groupDelegationFollowUpMessages } from "../ui/utils/delegationMessageGrouping.js";
import type { ChatMessage } from "../ui/stores/chatStore.js";

describe("groupDelegationFollowUpMessages", () => {
  test("folds text-only assistant messages after delegate_task into parent", () => {
    const delegationMessage: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      sequence: [
        {
          type: "tool",
          data: { name: "delegate_task", status: "success" },
        },
      ],
    };
    const followUp: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Sub-agent finished. Here is the summary.",
    };

    const grouped = groupDelegationFollowUpMessages([
      delegationMessage,
      followUp,
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.delegationFollowUps).toEqual([followUp]);
  });

  test("stops folding when a user message appears", () => {
    const delegationMessage: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", toolName: "delegate_task", args: {}, status: "success" }],
    };
    const followUp: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Summary",
    };
    const userReply: ChatMessage = {
      id: "msg-3",
      role: "user",
      content: "Thanks",
    };

    const grouped = groupDelegationFollowUpMessages([
      delegationMessage,
      followUp,
      userReply,
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.delegationFollowUps).toEqual([followUp]);
    expect(grouped[1]).toEqual(userReply);
  });
});
