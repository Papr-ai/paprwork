/**
 * Queued follow-ups — messages sent while the agent is working.
 *
 * The UX contract under test:
 *  - They sit at the bottom of the thread, where they will land, inside a
 *    dashed frame ("not sent yet"). Text is never faded.
 *  - One status phrase says when it goes.
 *  - Edit / Remove / Send now act on that message only.
 *  - When it is sent, the real message mounts with the landing class.
 *  - Auto-continue never jumps ahead of a waiting follow-up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  QUEUED_FOLD_MS,
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
    // The second in line waits its turn even while the first is going out.
    expect(pendingStatusText(false, 1)).toBe("Queued");
  });
  it("restored ones are Not sent", () => {
    expect(pendingStatusText(true, 0, true)).toBe("Not sent");
  });
});

describe("QueuedMessages (in the thread, dashed until sent)", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <QueuedMessages queue={[]} onSendNow={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("reads as your message, framed as not sent yet — never faded", () => {
    render(
      <QueuedMessages queue={[q("a", "also check the logs")]} onSendNow={vi.fn()} onRemove={vi.fn()} />,
    );
    const row = screen.getByTestId("queued-follow-up");
    expect(row.className).toContain("message-item");
    expect(row.querySelector(".queued-item__card")).toBeTruthy();
    expect(row.querySelector(".message-sender-name")).toBeTruthy();
    expect(row.getAttribute("style")).toBeNull();
    expect(screen.getByRole("list", { name: "Queued messages" })).toBeTruthy();
    expect(row.textContent).toContain("also check the logs");
    expect(row.textContent).toContain("Sends after current step");
  });


  it("Edit / Remove / Send now act on that message only", () => {
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    const onEdit = vi.fn();
    render(
      <QueuedMessages queue={[q("a", "first"), q("b", "second")]}
        onSendNow={onSendNow} onRemove={onRemove} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit message" })[1]);
    expect(onEdit).toHaveBeenCalledWith("b");
    // Last: Send now takes that row's buttons away while it says "Sending…".
    fireEvent.click(screen.getAllByRole("button", { name: "Send now" })[1]);
    expect(onSendNow).toHaveBeenCalledWith("b");
  });

  it("hides Edit when no handler is wired", () => {
    render(<QueuedMessages queue={[q("a", "x")]} onSendNow={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

describe("QueuedMessages motion (same as the Prototyper)", () => {
  const props = { onSendNow: vi.fn(), onRemove: vi.fn(), onEdit: vi.fn() };

  it("a removed message folds away, then is gone; the one below stays", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<QueuedMessages queue={[q("a", "first"), q("b", "second")]} {...props} />);
      fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0]);
      rerender(<QueuedMessages queue={[q("b", "second")]} {...props} />);
      const rows = screen.getAllByTestId("queued-follow-up");
      expect(rows).toHaveLength(2);
      expect(rows[0].className).toContain("queued-item--leaving");
      expect(rows[0].textContent).toContain("first");
      // The ghost has no live actions, and the survivor is now first in line.
      expect(rows[0].querySelector("button")).toBeNull();
      expect(rows[1].textContent).toContain("Sends after current step");
      act(() => { vi.advanceTimersByTime(QUEUED_FOLD_MS + 10); });
      expect(screen.getAllByTestId("queued-follow-up")).toHaveLength(1);
      expect(screen.queryByText("first")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Edit folds away the same way", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<QueuedMessages queue={[q("a", "first")]} {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
      rerender(<QueuedMessages queue={[]} {...props} />);
      expect(screen.getByTestId("queued-follow-up").className).toContain("queued-item--leaving");
      act(() => { vi.advanceTimersByTime(QUEUED_FOLD_MS + 10); });
      expect(screen.queryByTestId("queued-follow-up")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Send now holds its place as Sending… with no actions, then leaves without a ghost", async () => {
    let finish: () => void = () => {};
    const onSendNow = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const { rerender } = render(<QueuedMessages queue={[q("a", "go")]} {...props} onSendNow={onSendNow} />);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    const row = screen.getByTestId("queued-follow-up");
    expect(onSendNow).toHaveBeenCalledWith("a");
    expect(row.className).toContain("queued-item--sending");
    expect(row.textContent).toContain("Sending…");
    expect(row.querySelector("button")).toBeNull();
    // The real message takes its place: the queued copy is simply gone (no fold, no duplicate).
    rerender(<QueuedMessages queue={[]} {...props} onSendNow={onSendNow} />);
    expect(screen.queryByTestId("queued-follow-up")).toBeNull();
    await act(async () => { finish(); });
  });

  it("if sending fails the message is still there with its actions back", async () => {
    const onSendNow = vi.fn(() => Promise.reject(new Error("interrupt failed")));
    render(<QueuedMessages queue={[q("a", "go")]} {...props} onSendNow={onSendNow} />);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    process.off("unhandledRejection", unhandled);
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(screen.getByTestId("queued-follow-up").className).not.toContain("queued-item--sending");
  });

  it("the real message carries the status line that folds away as it lands", () => {
    markFollowUpLanding(CHAT, "use the blue one");
    const { container } = render(
      <MessageItem chatId={CHAT} message={{ id: "u9", role: "user", content: "use the blue one" } as ChatMessage} />,
    );
    expect(container.querySelector(".message-landing-meta")?.textContent).toContain("Sending…");
  });

  it("ordinary messages have no landing status", () => {
    const { container } = render(
      <MessageItem chatId={CHAT} message={{ id: "u10", role: "user", content: "hello" } as ChatMessage} />,
    );
    expect(container.querySelector(".message-landing-meta")).toBeNull();
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
