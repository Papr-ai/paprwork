/**
 * Thinking / effort / context / fast, remembered per chat.
 *
 * Mirrors {@link ./chatModelMemory} deliberately, including its central lesson:
 * a read for one chat must never fall back to a global value, or one chat's
 * choices leak into another and silently change what the next turn costs. The
 * global entry here is only ever the seed for a chat that has none of its own.
 *
 * Settings are stored sparsely — a key is written only once the user changes it
 * — so "unset" stays distinguishable from "set to the default". That matters
 * because model defaults differ (GLM ships at max effort, GPT at medium), and
 * an unset chat should follow its model rather than a value we invented.
 */

import {
  unpackEffortVariant,
  type EffortLevel,
} from "../constants/modelControls";

export interface ChatModelSettings {
  thinking?: boolean;
  effort?: EffortLevel;
  contextLimit?: number;
  fast?: boolean;
}

/**
 * Do two settings objects mean the same thing?
 *
 * Every read here builds a fresh object, so React state holding one of these
 * cannot be compared by reference: setting it from a re-read would always look
 * like a change, and an effect that both depends on state and re-reads it would
 * spin. Callers use this to bail out instead.
 */
export function sameSettings(
  a: ChatModelSettings,
  b: ChatModelSettings,
): boolean {
  return (
    a.thinking === b.thinking &&
    a.effort === b.effort &&
    a.contextLimit === b.contextLimit &&
    a.fast === b.fast
  );
}

/** chatId -> settings. Insertion-ordered; oldest entries are evicted first. */
const PER_CHAT_KEY = "paprwork_chat_model_settings";

/** Seed for a brand-new chat. */
const NEW_CHAT_DEFAULT_KEY = "paprwork_default_model_settings";

/** Matches {@link ./chatModelMemory}: this map is written for the life of the install. */
export const MAX_REMEMBERED_CHATS = 200;

type SettingsMap = Record<string, ChatModelSettings>;

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

const VALID_EFFORTS = new Set<string>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Keep only well-formed fields rather than trusting the stored blob. A bad
 * value here becomes a request parameter, so it is worth dropping silently.
 */
export function sanitizeSettings(value: unknown): ChatModelSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const clean: ChatModelSettings = {};

  if (typeof raw.thinking === "boolean") {
    clean.thinking = raw.thinking;
  }
  if (typeof raw.effort === "string" && VALID_EFFORTS.has(raw.effort)) {
    clean.effort = raw.effort as EffortLevel;
  }
  if (
    typeof raw.contextLimit === "number" &&
    Number.isFinite(raw.contextLimit) &&
    raw.contextLimit > 0
  ) {
    clean.contextLimit = Math.floor(raw.contextLimit);
  }
  if (typeof raw.fast === "boolean") {
    clean.fast = raw.fast;
  }

  return Object.keys(clean).length > 0 ? clean : null;
}

function readMap(): SettingsMap {
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
    const clean: SettingsMap = {};
    for (const [chatId, settings] of Object.entries(parsed)) {
      const sanitized = sanitizeSettings(settings);
      if (chatId && sanitized) {
        clean[chatId] = sanitized;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeMap(map: SettingsMap): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(PER_CHAT_KEY, JSON.stringify(map));
  } catch {
    /* quota or disabled storage — settings degrade to in-memory only */
  }
}

/** Settings this chat has explicitly established, if any. */
export function readChatSettings(chatId: string): ChatModelSettings {
  if (!chatId) {
    return {};
  }
  return readMap()[chatId] ?? {};
}

/**
 * Merge a change into one chat's settings. Re-writing refreshes the entry's
 * position, so chats the user returns to are the last to be evicted.
 */
export function writeChatSettings(
  chatId: string,
  patch: ChatModelSettings,
): ChatModelSettings {
  if (!chatId) {
    return {};
  }

  const map = readMap();
  const merged = sanitizeSettings({ ...map[chatId], ...patch }) ?? {};

  delete map[chatId];
  map[chatId] = merged;

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
  return merged;
}

/** Forget a chat's settings — call when the chat is deleted. */
export function forgetChatSettings(chatId: string): void {
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
 * Carry settings across the temp-id -> permanent-id rename on a chat's first
 * message, so choices made before sending are not lost when it is persisted.
 */
export function renameChatSettings(oldChatId: string, newChatId: string): void {
  if (!oldChatId || !newChatId || oldChatId === newChatId) {
    return;
  }
  const map = readMap();
  const settings = map[oldChatId];
  if (!settings) {
    return;
  }
  delete map[oldChatId];
  map[newChatId] = settings;
  writeMap(map);
}

/**
 * Carry a retired effort-variant model's effort into the chat's own settings.
 *
 * A chat pinned to `gpt-5-6-sol-high` now resolves to `gpt-5-6-sol`, and
 * without this it would quietly drop from high effort to the model's default.
 * An effort the user has since set explicitly wins — this only fills the gap.
 *
 * @returns the effort that was adopted, or null when there was nothing to do.
 */
export function adoptEffortFromVariant(
  chatId: string,
  pinnedModelId: string | null | undefined,
): EffortLevel | null {
  if (!chatId || !pinnedModelId) {
    return null;
  }
  const { effort } = unpackEffortVariant(pinnedModelId);
  if (!effort) {
    return null;
  }
  if (readChatSettings(chatId).effort) {
    return null;
  }
  writeChatSettings(chatId, { effort });
  return effort;
}

/** What a brand-new chat should open with. Global on purpose. */
export function readNewChatDefaultSettings(): ChatModelSettings {
  const store = storage();
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(NEW_CHAT_DEFAULT_KEY);
    return raw ? (sanitizeSettings(JSON.parse(raw)) ?? {}) : {};
  } catch {
    return {};
  }
}

export function writeNewChatDefaultSettings(settings: ChatModelSettings): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(NEW_CHAT_DEFAULT_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
