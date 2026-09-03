/**
 * Which model each chat is using, and which model a *new* chat should start on.
 *
 * These are two different questions, and conflating them let one chat's model
 * bleed into another. Per-chat selection used to live only in an in-memory
 * Zustand map, so every app restart and every workspace switch emptied it —
 * after which a read for chat A fell back to the single global "last model" and
 * returned whatever had been picked last in *any* chat. That is not cosmetic:
 * the picker value is what gets sent as `config.model`, so the wrong model
 * actually answered.
 *
 * So per-chat selection is persisted here, keyed by chat, and the global value
 * is kept strictly as the seed for chats that have no history of their own.
 */

/** chatId -> modelId. Insertion-ordered; oldest entries are evicted first. */
const PER_CHAT_KEY = "paprwork_chat_model_ids";

/** Single value: what a brand-new chat should open on. */
const NEW_CHAT_DEFAULT_KEY = "paprwork_last_model_id";

/**
 * Cap on remembered chats. Selections are tiny, but this map is written on
 * every model change for the life of the install, so it needs a ceiling.
 */
export const MAX_REMEMBERED_CHATS = 200;

type ChatModelMap = Record<string, string>;

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

function readMap(): ChatModelMap {
  const store = storage();
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(PER_CHAT_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Drop anything that is not a plain string pair rather than trusting the blob.
    const clean: ChatModelMap = {};
    for (const [chatId, modelId] of Object.entries(parsed)) {
      if (
        typeof chatId === "string" &&
        typeof modelId === "string" &&
        modelId
      ) {
        clean[chatId] = modelId;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeMap(map: ChatModelMap): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(PER_CHAT_KEY, JSON.stringify(map));
  } catch {
    /* quota or disabled storage — selection degrades to in-memory only */
  }
}

/** The model this specific chat is on, if it has ever been established. */
export function readChatModel(chatId: string): string | undefined {
  if (!chatId) {
    return undefined;
  }
  return readMap()[chatId];
}

/**
 * Record the model for one chat. Re-writing an existing chat refreshes its
 * position, so the chats a user actually returns to are the last to be evicted.
 */
export function writeChatModel(chatId: string, modelId: string): void {
  if (!chatId || !modelId) {
    return;
  }

  const map = readMap();
  delete map[chatId];
  map[chatId] = modelId;

  const chatIds = Object.keys(map);
  if (chatIds.length > MAX_REMEMBERED_CHATS) {
    for (const stale of chatIds.slice(
      0,
      chatIds.length - MAX_REMEMBERED_CHATS,
    )) {
      delete map[stale];
    }
  }

  writeMap(map);
}

/** Forget a chat's model — call when the chat is deleted. */
export function forgetChatModel(chatId: string): void {
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
 * Carry a selection across the temp-id -> permanent-id rename that happens on
 * the first message of a new chat. Without this, the chat loses its model the
 * moment it is persisted.
 */
export function renameChatModel(oldChatId: string, newChatId: string): void {
  if (!oldChatId || !newChatId || oldChatId === newChatId) {
    return;
  }
  const map = readMap();
  const modelId = map[oldChatId];
  if (!modelId) {
    return;
  }
  delete map[oldChatId];
  map[newChatId] = modelId;
  writeMap(map);
}

/**
 * What a brand-new chat should open on: the last model the user picked
 * anywhere. Deliberately global — this is the one place that is correct.
 */
export function readNewChatDefaultModel(): string | undefined {
  const store = storage();
  if (!store) {
    return undefined;
  }
  try {
    return store.getItem(NEW_CHAT_DEFAULT_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function writeNewChatDefaultModel(modelId: string): void {
  const store = storage();
  if (!store || !modelId) {
    return;
  }
  try {
    store.setItem(NEW_CHAT_DEFAULT_KEY, modelId);
  } catch {
    /* ignore */
  }
}
