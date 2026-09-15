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

  test("folds deferred follow-up onto delegate by delegation id", () => {
    const delegationMessage: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          toolName: "delegate_task",
          args: {},
          status: "success",
          result: JSON.stringify({
            id: "del-123",
            task: "Architect brief",
            status: "completed",
          }),
        },
      ],
    };
    const middleUser: ChatMessage = {
      id: "msg-2",
      role: "user",
      content: "Keep going",
    };
    const middleAssistant: ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "Building the prototype now.",
    };
    const syntheticTrigger: ChatMessage = {
      id: "msg-4",
      role: "user",
      content:
        "[Sub-agent delegation finished for del-123]\n\nThe Product Architect completed.",
    };
    const followUp: ChatMessage = {
      id: "msg-5",
      role: "assistant",
      content: "Product Architect finished — full report is on the card above.",
    };

    const grouped = groupDelegationFollowUpMessages([
      delegationMessage,
      middleUser,
      middleAssistant,
      syntheticTrigger,
      followUp,
    ]);

    expect(grouped.map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
    expect(grouped[0]?.delegationFollowUps).toEqual([followUp]);
  });

  test("folds deferred follow-up that used get_delegation_run", () => {
    const delegationMessage: ChatMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          toolName: "delegate_task",
          args: {},
          status: "success",
          result: JSON.stringify({ id: "del-456", task: "Explore repo" }),
        },
      ],
    };
    const middleUser: ChatMessage = {
      id: "msg-2",
      role: "user",
      content: "how do tokens come into play here?",
    };
    const followUp: ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "Codebase Explorer failed — model not supported on Codex OAuth.",
      toolCalls: [
        {
          id: "t2",
          toolName: "get_delegation_run",
          args: { runId: "del-456" },
          status: "success",
        },
      ],
      delegationFinishFor: "del-456",
    };

    const grouped = groupDelegationFollowUpMessages([
      delegationMessage,
      middleUser,
      followUp,
    ]);

    expect(grouped.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
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
