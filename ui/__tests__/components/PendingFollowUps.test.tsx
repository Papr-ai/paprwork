/**
 * Queued follow-ups — messages sent while the agent is working.
 *
 * The UX contract under test:
 *  - They wait in a stack above the input bar, NOT in the transcript: the
 *    transcript only shows what the agent has actually received.
 *  - Text is solid and readable; one status phrase says when it goes.
 *  - Edit / Remove / Send now act on that message only.
 *  - When it is sent, the real message mounts with the landing class.
 *  - Auto-continue never jumps ahead of a waiting follow-up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  QueuedMessages,
  pendingStatusText,
  type QueuedMessage,
} from "../../components/Chat/QueuedMessages";
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
  it("the first one sends after the current step", () => {
    expect(pendingStatusText(true, 0)).toBe("Sends after current step");
  });
  it("later ones are simply queued", () => {
    expect(pendingStatusText(true, 1)).toBe("Queued");
  });
  it("says Sending… once the agent is idle", () => {
    expect(pendingStatusText(false, 0)).toBe("Sending…");
  });
  it("restored ones are Not sent", () => {
    expect(pendingStatusText(true, 0, true)).toBe("Not sent");
  });
});

describe("QueuedMessages (stack above the input bar)", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <QueuedMessages queue={[]} onSendNow={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("is a compact list row, not a ghosted transcript message", () => {
    render(
      <QueuedMessages queue={[q("a", "also check the logs")]} onSendNow={vi.fn()} onRemove={vi.fn()} />,
    );
    const row = screen.getByTestId("queued-follow-up");
    expect(row.querySelector('[data-testid="message-item-user"]')).toBeNull();
    expect(screen.getByRole("list", { name: "Queued messages" })).toBeTruthy();
    expect(row.textContent).toContain("also check the logs");
    expect(row.textContent).toContain("Sends after current step");
  });

  it("click expands a long message and collapses it again", () => {
    render(<QueuedMessages queue={[q("a", "long text")]} onSendNow={vi.fn()} onRemove={vi.fn()} />);
    const text = screen.getByRole("button", { name: "long text" });
    expect(text.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(text);
    expect(text.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(text);
    expect(text.getAttribute("aria-expanded")).toBe("false");
  });

  it("Edit / Remove / Send now act on that message only", () => {
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    render(
      <QueuedMessages queue={[q("a", "first"), q("b", "second")]}
        onSendNow={onSendNow} onRemove={onRemove} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Send now" })[1]);
    expect(onSendNow).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit message" })[1]);
    expect(onEdit).toHaveBeenCalledWith("b");
  });

  it("hides Edit when no handler is wired", () => {
    render(<QueuedMessages queue={[q("a", "x")]} onSendNow={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

describe("follow-up landing (slides into the transcript)", () => {
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
