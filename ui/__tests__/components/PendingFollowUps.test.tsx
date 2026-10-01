/**
 * Pending follow-ups — messages sent while the agent is working.
 *
 * The UX contract under test:
 *  - The follow-up shows INLINE in the transcript, at the very bottom (below
 *    the work in progress), in the user's own message layout — not in a tray.
 *  - One status line says when the agent will read it.
 *  - "Send now" and "Remove" act on that message only.
 *  - When the real message is sent, it mounts with the landing class so it
 *    finishes ghost → solid instead of popping in.
 *  - Auto-continue never jumps ahead of a waiting follow-up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  QueuedMessages,
  pendingStatusText,
  type QueuedMessage,
} from "../../components/Chat/QueuedMessages";
import { MessageList } from "../../components/Chat/MessageList";
import { MessageItem } from "../../components/Chat/MessageItem";
import {
  isLandingFollowUp,
  markFollowUpLanding,
  resetFollowUpLandingForTests,
} from "../../utils/followUpLanding";
import { getAutoContinueBlockReason } from "../../lib/agentStreamRecovery";
import type { ChatMessage } from "../../types/chat";

const CHAT = "chat-pending";

function q(id: string, text: string): QueuedMessage {
  return { id, text, chatId: CHAT, timestamp: Date.now() };
}

afterEach(() => resetFollowUpLandingForTests());

describe("pendingStatusText", () => {
  it("tells the user the agent reads it after the current step", () => {
    expect(pendingStatusText("Pen", true, 0)).toBe(
      "Pen reads this after the current step",
    );
  });
  it("marks later follow-ups as queued behind the first", () => {
    expect(pendingStatusText("Pen", true, 1)).toBe(
      "Queued · Pen reads this next",
    );
  });
  it("says Sending… once the agent is idle and the drain is about to send", () => {
    expect(pendingStatusText("Pen", false, 0)).toBe("Sending…");
  });
});

describe("QueuedMessages (inline pending follow-ups)", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <QueuedMessages queue={[]} onSendNow={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the follow-up in the user's message layout with a status line", () => {
    render(
      <QueuedMessages
        queue={[q("a", "also check the logs")]}
        onSendNow={vi.fn()}
        onRemove={vi.fn()}
        agentName="Pen"
      />,
    );
    const item = screen.getByTestId("pending-follow-up");
    expect(item.querySelector('[data-testid="message-item-user"]')).not.toBeNull();
    expect(item.textContent).toContain("also check the logs");
    expect(item.textContent).toContain("Pen reads this after the current step");
  });

  it("Send now and Remove act on that message only", () => {
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    render(
      <QueuedMessages
        queue={[q("a", "first"), q("b", "second")]}
        onSendNow={onSendNow}
        onRemove={onRemove}
      />,
    );
    const items = screen.getAllByTestId("pending-follow-up");
    fireEvent.click(items[1].querySelector("button")!);
    expect(onSendNow).toHaveBeenCalledWith("b");
    fireEvent.click(items[0].querySelector('[aria-label="Remove message"]')!);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("sits below the work in progress — after the last transcript message", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "build it" },
      { id: "a1", role: "assistant", content: "working…", isStreaming: true },
    ] as ChatMessage[];
    const { container } = render(
      <MessageList
        chatId={CHAT}
        messages={messages}
        isSending
        pendingFollowUpCount={1}
        pendingFollowUps={
          <QueuedMessages
            queue={[q("p1", "use the blue one")]}
            onSendNow={vi.fn()}
            onRemove={vi.fn()}
          />
        }
      />,
    );
    const pending = screen.getByTestId("pending-follow-up");
    const nodes = container.querySelectorAll(
      '.message-list > [data-testid="message-item-user"], .message-list > [data-testid="message-item-assistant"]',
    );
    const lastTranscriptItem = nodes[nodes.length - 1];
    expect(lastTranscriptItem).toBeTruthy();
    expect(
      lastTranscriptItem.compareDocumentPosition(pending) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("follow-up landing (ghost → solid)", () => {
  it("matches the user message that was just sent from the queue", () => {
    markFollowUpLanding(CHAT, "use the blue one", 1_000);
    expect(
      isLandingFollowUp(CHAT, { role: "user", content: "use the blue one" }, 1_500),
    ).toBe(true);
  });

  it("ignores assistant messages, other text, other chats, and stale marks", () => {
    markFollowUpLanding(CHAT, "x", 1_000);
    expect(isLandingFollowUp(CHAT, { role: "assistant", content: "x" }, 1_100)).toBe(false);
    expect(isLandingFollowUp(CHAT, { role: "user", content: "y" }, 1_100)).toBe(false);
    expect(isLandingFollowUp("other", { role: "user", content: "x" }, 1_100)).toBe(false);
    expect(isLandingFollowUp(CHAT, { role: "user", content: "x" }, 9_000)).toBe(false);
  });

  it("the real message mounts with the landing class", () => {
    markFollowUpLanding(CHAT, "use the blue one");
    render(
      <MessageItem
        chatId={CHAT}
        message={{ id: "u2", role: "user", content: "use the blue one" } as ChatMessage}
      />,
    );
    expect(screen.getByTestId("message-item-user").className).toContain(
      "message-item--landing",
    );
  });

  it("ordinary messages do not get the landing class", () => {
    render(
      <MessageItem
        chatId={CHAT}
        message={{ id: "u3", role: "user", content: "hello" } as ChatMessage}
      />,
    );
    expect(screen.getByTestId("message-item-user").className).not.toContain(
      "message-item--landing",
    );
  });
});

describe("auto-continue vs a waiting follow-up", () => {
  it("never jumps ahead of the user's queued message", () => {
    const messages = [
      { id: "u1", role: "user", content: "go" },
      { id: "a1", role: "assistant", content: "", interrupted: true },
    ] as ChatMessage[];
    expect(
      getAutoContinueBlockReason({
        chatId: CHAT,
        messages,
        isSending: false,
        connectionPaused: false,
        needsStreamRecovery: false,
        gatewayReady: true,
        hasQueuedFollowUp: true,
      }),
    ).toBe("queuedFollowUp");
  });

  it("stacks with master's live-stream guard — both block, live stream wins", () => {
    const messages = [
      { id: "u1", role: "user", content: "go" },
      { id: "a1", role: "assistant", content: "", interrupted: true },
    ] as ChatMessage[];
    const base = {
      chatId: CHAT,
      messages,
      isSending: false,
      connectionPaused: false,
      needsStreamRecovery: false,
      gatewayReady: true,
    };
    expect(getAutoContinueBlockReason({ ...base, liveStreamRequestId: "r1" })).toBe("isSending");
    expect(
      getAutoContinueBlockReason({ ...base, liveStreamRequestId: "r1", hasQueuedFollowUp: true }),
    ).toBe("isSending");
    expect(getAutoContinueBlockReason({ ...base, hasQueuedFollowUp: true })).toBe("queuedFollowUp");
  });
});
