/**
 * Queued follow-ups must survive leaving the chat.
 *
 * Bug: the queue was useState inside ChatContainer. Switching to a mini-app
 * tab unmounted the chat and four unsent messages vanished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_QUEUED_FOLLOW_UPS,
  QUEUE_STORAGE_KEY,
  readPersistedQueue,
  resetMessageQueueStoreForTests,
  useMessageQueueStore,
  writePersistedQueue,
} from "../../stores/messageQueueStore";
import {
  QueuedMessages,
  pendingStatusText,
  type QueuedMessage,
} from "../../components/Chat/QueuedMessages";

function q(id: string, chatId = "chat-a", text = `msg ${id}`): QueuedMessage {
  return { id, chatId, text, timestamp: 1 };
}

/** Stand-in for ChatContainer: reads the queue for one chat. */
function QueueReader({ chatId }: { chatId: string }) {
  const queue = useMessageQueueStore((s) => s.queue);
  return <div data-testid="count">{queue.filter((m) => m.chatId === chatId).length}</div>;
}

beforeEach(() => {
  localStorage.clear();
  resetMessageQueueStoreForTests();
});
afterEach(() => localStorage.clear());

describe("queued follow-ups survive leaving the chat", () => {
  it("are still there after the chat unmounts and remounts (tab switch)", () => {
    const { unmount } = render(<QueueReader chatId="chat-a" />);
    act(() => {
      useMessageQueueStore.getState().setQueue((prev) => [
        ...prev, q("1"), q("2"), q("3"), q("4"),
      ]);
    });
    expect(screen.getByTestId("count").textContent).toBe("4");
    unmount(); // user opens a mini-app tab
    render(<QueueReader chatId="chat-a" />); // …and comes back
    expect(screen.getByTestId("count").textContent).toBe("4");
    // Same session: still live, not held — they send after the current step.
    expect(useMessageQueueStore.getState().queue.every((m) => !m.held)).toBe(true);
  });

  it("are written through to localStorage on every change", () => {
    useMessageQueueStore.getState().setQueue(() => [q("1"), q("2", "chat-b")]);
    const stored = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY)!);
    expect(stored.map((m: QueuedMessage) => m.id)).toEqual(["1", "2"]);
    useMessageQueueStore.getState().setQueue(() => []);
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("come back held after a restart — never auto-sent", () => {
    writePersistedQueue([q("1"), q("2")]);
    resetMessageQueueStoreForTests(); // simulates a fresh app session
    const queue = useMessageQueueStore.getState().queue;
    expect(queue.map((m) => m.id)).toEqual(["1", "2"]);
    expect(queue.every((m) => m.held)).toBe(true);
  });

  it("ignores corrupt storage instead of crashing the chat", () => {
    localStorage.setItem(QUEUE_STORAGE_KEY, "{not json");
    expect(readPersistedQueue()).toEqual([]);
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ id: 1 }, q("ok")]));
    expect(readPersistedQueue().map((m) => m.id)).toEqual(["ok"]);
  });

  it("caps what it stores, keeping the newest", () => {
    const many = Array.from({ length: MAX_QUEUED_FOLLOW_UPS + 5 }, (_, i) => q(String(i)));
    writePersistedQueue(many);
    const stored = readPersistedQueue();
    expect(stored).toHaveLength(MAX_QUEUED_FOLLOW_UPS);
    expect(stored[stored.length - 1].id).toBe(String(MAX_QUEUED_FOLLOW_UPS + 4));
  });
});

describe("held (not sent) follow-ups in the queue", () => {
  it("say Not sent and offer Send when the agent is idle", () => {
    expect(pendingStatusText(false, 0, true)).toBe("Not sent");
    const onSendNow = vi.fn();
    render(
      <QueuedMessages
        queue={[{ ...q("h"), held: true }]}
        onSendNow={onSendNow}
        onRemove={() => {}}
        agentWorking={false}
      />,
    );
    const item = screen.getByTestId("queued-follow-up");
    expect(item.className).toContain("queued-item--held");
    expect(item.textContent).toContain("Not sent");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSendNow).toHaveBeenCalledWith("h");
  });
});
