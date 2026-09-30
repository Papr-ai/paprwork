/**
 * Unsent composer text, kept somewhere it can survive the app dying.
 *
 * Drafts lived only in a Zustand `Map`, which meant a renderer crash, a reload
 * or a workspace switch threw away whatever the user was mid-way through
 * typing. The type even called the field "Persisted draft message for this
 * chat" — it was not persisted anywhere.
 *
 * A draft is the one piece of chat state the user cannot reproduce: messages
 * come back from the server, but text that was never sent exists nowhere else.
 * So it is written straight to `localStorage`, synchronously, on the same
 * debounce that already fed the store. Nothing here depends on React, so it
 * still runs when the tree above it has thrown.
 */

/** chatId -> unsent text. Insertion-ordered; oldest entries evicted first. */
const DRAFTS_KEY = "paprwork_chat_drafts";

/**
 * Cap on remembered drafts. Kept well below the model map's 200 because a
 * draft is a whole message rather than an id, and `localStorage` is a shared
 * ~5MB budget for the entire renderer.
 */
export const MAX_REMEMBERED_DRAFTS = 50;

/**
 * Cap on one draft, in characters.
 *
 * A composer accepts pasted input, so this is attacker-shaped in the ordinary
 * sense that a user can paste a novel into it. Without a cap one paste could
 * consume the whole storage budget and start throwing quota errors on every
 * other key in the app.
 */
export const MAX_DRAFT_CHARS = 100_000;

type DraftMap = Record<string, string>;

function storage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    // Storage can throw outright when disabled by policy.
    return null;
  }
}

function readMap(): DraftMap {
  const store = storage();
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(DRAFTS_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const clean: DraftMap = {};
    for (const [chatId, draft] of Object.entries(parsed)) {
      if (typeof chatId === "string" && typeof draft === "string" && draft) {
        clean[chatId] = draft;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeMap(map: DraftMap): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // Over quota. Drop everything but the chat we just wrote rather than
    // leaving the draft unsaved: the newest draft is the one being typed, and
    // it is the only one the user would notice losing.
    const chatIds = Object.keys(map);
    const newest = chatIds[chatIds.length - 1];
    if (!newest) {
      return;
    }
    try {
      store.setItem(DRAFTS_KEY, JSON.stringify({ [newest]: map[newest] }));
    } catch {
      /* storage is unusable — drafts degrade to in-memory only */
    }
  }
}

/** The unsent text for one chat, or "" when there is none. */
export function readDraft(chatId: string): string {
  if (!chatId) {
    return "";
  }
  return readMap()[chatId] ?? "";
}

/**
 * Record the unsent text for one chat. Writing an existing chat refreshes its
 * position, so the chats a user is actively typing in are evicted last.
 *
 * An empty draft removes the entry rather than storing "", so a cleared
 * composer does not occupy a slot.
 */
export function writeDraft(chatId: string, draft: string): void {
  if (!chatId) {
    return;
  }

  const map = readMap();
  delete map[chatId];

  if (draft) {
    map[chatId] = draft.slice(0, MAX_DRAFT_CHARS);
  }

  const chatIds = Object.keys(map);
  if (chatIds.length > MAX_REMEMBERED_DRAFTS) {
    for (const stale of chatIds.slice(
      0,
      chatIds.length - MAX_REMEMBERED_DRAFTS,
    )) {
      delete map[stale];
    }
  }

  writeMap(map);
}

/** Forget a chat's draft — on send, or when the chat is deleted. */
export function forgetDraft(chatId: string): void {
  if (!chatId) {
    return;
  }
  const map = readMap();
  if (!(chatId in map)) {
    return;
  }
  delete map[chatId];
  writeMap(map);
}

/**
 * Carry a draft across the temp-id -> permanent-id rename.
 *
 * Reachable in practice: the first message of a new chat triggers the rename,
 * and a user can start typing a *second* message while that first one is still
 * streaming.
 */
export function renameDraft(oldChatId: string, newChatId: string): void {
  if (!oldChatId || !newChatId || oldChatId === newChatId) {
    return;
  }
  const map = readMap();
  const draft = map[oldChatId];
  if (!draft) {
    return;
  }
  delete map[oldChatId];
  map[newChatId] = draft;
  writeMap(map);
}
