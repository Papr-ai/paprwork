/**
 * Follow-ups the user sent while the agent was working — kept where they
 * survive leaving the chat.
 *
 * The queue used to be `useState` inside ChatContainer. Only mini-app tabs are
 * kept alive, so switching to an app (or any other tab) unmounted the chat and
 * silently threw the queue away: four messages the user had typed and pressed
 * Enter on, gone. A queued follow-up is like a draft — it exists nowhere else
 * until it is sent — so it gets the same durability as drafts
 * (see utils/chatDraftStore.ts): a store above the component tree, written
 * through to localStorage.
 *
 * Restore rules:
 *  - Same session (tab switch, chat switch): the queue is still in memory and
 *    resumes exactly as it was — it sends after the agent's current step.
 *  - New session (app restart, reload, crash): restored items come back
 *    `held`. They are never auto-sent hours later; the user sees them in place
 *    as "Not sent" and chooses Send or Remove.
 *
 * Device-local on purpose: these are intents for a turn running on this
 * desktop, not shared chat history. Server persistence would add sync
 * conflicts for no user-visible gain.
 */
import { create } from "zustand";
import type { QueuedMessage } from "../components/Chat/QueuedMessages";
import type { Artifact } from "./artifactsStore";

export const QUEUE_STORAGE_KEY = "paprwork_queued_follow_ups";
/** Whole-app cap (all chats). Oldest dropped first. */
export const MAX_QUEUED_FOLLOW_UPS = 50;
export const MAX_QUEUED_TEXT_CHARS = 100_000;
/** Artifact bodies are re-fetchable; never spend storage budget on big ones. */
const MAX_PERSISTED_ARTIFACT_CONTENT = 20_000;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.chatId === "string" &&
    typeof v.text === "string" &&
    typeof v.timestamp === "number"
  );
}

/** Items from a previous session come back held — never auto-sent. */
export function readPersistedQueue(): QueuedMessage[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isQueuedMessage)
      .map((item) => ({ ...item, held: true }));
  } catch {
    return [];
  }
}

function slimArtifacts(artifacts?: Artifact[]): Artifact[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((a) =>
    typeof a.content === "string" &&
    a.content.length > MAX_PERSISTED_ARTIFACT_CONTENT
      ? { ...a, content: undefined }
      : a,
  );
}

export function writePersistedQueue(queue: QueuedMessage[]): void {
  const store = storage();
  if (!store) return;
  if (queue.length === 0) {
    try {
      store.removeItem(QUEUE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  const slim = queue.slice(-MAX_QUEUED_FOLLOW_UPS).map((item) => ({
    ...item,
    text: item.text.slice(0, MAX_QUEUED_TEXT_CHARS),
    contextArtifacts: slimArtifacts(item.contextArtifacts),
  }));
  try {
    store.setItem(QUEUE_STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // Quota: keep the words, drop attachments — the text is what matters.
    try {
      store.setItem(
        QUEUE_STORAGE_KEY,
        JSON.stringify(slim.map(({ contextArtifacts: _a, ...rest }) => rest)),
      );
    } catch {
      /* storage unavailable — in-memory queue still survives tab switches */
    }
  }
}

interface MessageQueueState {
  queue: QueuedMessage[];
  /** Same updater shape as React's setState, across all chats. */
  setQueue: (updater: (prev: QueuedMessage[]) => QueuedMessage[]) => void;
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queue: readPersistedQueue(),
  setQueue: (updater) => {
    const prev = get().queue;
    const next = updater(prev);
    if (next === prev) return;
    writePersistedQueue(next);
    set({ queue: next });
  },
}));

export function resetMessageQueueStoreForTests(): void {
  useMessageQueueStore.setState({ queue: readPersistedQueue() });
}
