/**
 * UserMemoryContextService - Chat-start cross-chat memory bootstrap
 *
 * On new chats or after ~2h idle, prefetches goals, use cases, sync tiers, and
 * message-scoped search. Fetches run in the background on the trigger turn so the
 * first agent response is not blocked; blocks inject on the following turn.
 */

import Papr from "@papr/memory";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  fetchParseGoalsForUser,
  fetchParseUsecasesForUser,
  formatGoalsOkrsBlock,
  formatUseCasesBlock,
  GOALS_OKRS_PREFIX,
  USE_CASES_PREFIX,
} from "../utils/parseUserContext.js";
import { getPaprUserId } from "../utils/paprUserId.js";

export const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const MAX_TIER0 = 20;
export const MAX_TIER1 = 25;
/** Papr API requires max_memories >= 10 */
export const MAX_SEARCH_MEMORIES = 10;
export const MAX_MEMORY_CHAR_PER_ITEM = 400;
export const MAX_BLOCK_CHARS = 3500;

export type MemoryBootstrapMode = "stream" | "inspect";

interface HistoryMessageLike {
  role?: unknown;
  message_role?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
}

interface ChatBootstrapState {
  blocks: string[] | null;
  fetchPromise: Promise<string[]> | null;
  injected: boolean;
}

function createEmptyBootstrapState(): ChatBootstrapState {
  return { blocks: null, fetchPromise: null, injected: false };
}

function extractRole(message: HistoryMessageLike): string | null {
  const role = message.role ?? message.message_role;
  return typeof role === "string" ? role : null;
}

function parseTimestamp(message: HistoryMessageLike): number | null {
  const ts = message.timestamp ?? message.createdAt;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts;
  }
  return null;
}

function getConversationalMessages(history: unknown[]): HistoryMessageLike[] {
  return history.filter((entry): entry is HistoryMessageLike => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const role = extractRole(entry as HistoryMessageLike);
    return role === "user" || role === "assistant";
  });
}

function findLastPriorMessageTimestamp(
  conversational: HistoryMessageLike[],
): number | null {
  if (conversational.length < 2) {
    return null;
  }

  for (let i = conversational.length - 2; i >= 0; i--) {
    const ts = parseTimestamp(conversational[i]);
    if (ts !== null) {
      return ts;
    }
  }

  return null;
}

/**
 * Bootstrap when first message in chat or last prior message is older than idle threshold.
 * Assumes history includes the current user message as the last entry.
 */
export function shouldBootstrapUserMemory(
  history: unknown[],
  idleThresholdMs: number = IDLE_THRESHOLD_MS,
): boolean {
  const conversational = getConversationalMessages(history);

  if (conversational.length === 0) {
    return true;
  }

  if (conversational.length === 1) {
    return extractRole(conversational[0]) === "user";
  }

  const lastPriorTs = findLastPriorMessageTimestamp(conversational);
  if (lastPriorTs === null) {
    return true;
  }

  return Date.now() - lastPriorTs >= idleThresholdMs;
}

function truncateMemoryContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.substring(0, maxChars)}...`;
}

function formatMemoryLine(memory: MemoryObject): string {
  const category = memory.category ? `[${memory.category}] ` : "";
  const type = memory.type ? `(${memory.type}) ` : "";
  return `- ${category}${type}${truncateMemoryContent(memory.content, MAX_MEMORY_CHAR_PER_ITEM)}`;
}

export const CROSS_CHAT_CONTEXT_PREFIX = "[CROSS-CHAT USER CONTEXT";
export const RELATED_MEMORY_PREFIX = "[RELATED MEMORY";

export function isMemoryContextUserMessage(content: string): boolean {
  return (
    content.startsWith(GOALS_OKRS_PREFIX) ||
    content.startsWith(USE_CASES_PREFIX) ||
    content.startsWith(CROSS_CHAT_CONTEXT_PREFIX) ||
    content.startsWith(RELATED_MEMORY_PREFIX)
  );
}

export function classifyMemoryBlock(
  block: string,
):
  | "parse_goals"
  | "parse_usecases"
  | "sync_tiers"
  | "related_memory"
  | "unknown" {
  if (block.startsWith(GOALS_OKRS_PREFIX)) {
    return "parse_goals";
  }
  if (block.startsWith(USE_CASES_PREFIX)) {
    return "parse_usecases";
  }
  if (block.startsWith(CROSS_CHAT_CONTEXT_PREFIX)) {
    return "sync_tiers";
  }
  if (block.startsWith(RELATED_MEMORY_PREFIX)) {
    return "related_memory";
  }
  return "unknown";
}

export function formatSyncTiersBlock(
  tier0: MemoryObject[],
  tier1: MemoryObject[],
): string | undefined {
  if (tier0.length === 0 && tier1.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  if (tier0.length > 0) {
    lines.push(
      "**Tier 0 — Priority memories (Papr-ranked; may include goals, OKRs, or conversation summaries):**",
    );
    for (const memory of tier0) {
      lines.push(formatMemoryLine(memory));
    }
  }

  if (tier1.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**Tier 1 — Recent / hot memories:**");
    for (const memory of tier1) {
      lines.push(formatMemoryLine(memory));
    }
  }

  let body = lines.join("\n");
  if (body.length > MAX_BLOCK_CHARS) {
    body = `${body.substring(0, MAX_BLOCK_CHARS)}\n[... truncated]`;
  }

  return `${CROSS_CHAT_CONTEXT_PREFIX} — background from other conversations; may not reflect your current task]

${body}

Use search_agent_memory for task-specific recall if you need more detail.`;
}

export function formatMessageSearchBlock(
  memories: MemoryObject[],
): string | undefined {
  if (memories.length === 0) {
    return undefined;
  }

  let body = memories.map((memory) => formatMemoryLine(memory)).join("\n");
  if (body.length > MAX_BLOCK_CHARS) {
    body = `${body.substring(0, MAX_BLOCK_CHARS)}\n[... truncated]`;
  }

  return `${RELATED_MEMORY_PREFIX} — matched to the user's current message]

${body}

These may be relevant to this request. Call search_agent_memory for deeper recall.`;
}

async function createPaprClient(): Promise<Papr | null> {
  const { getApiKey } = await import("../utils/keyResolver.js");
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    return null;
  }

  return new Papr({
    xAPIKey: apiKey,
    maxRetries: 1,
    timeout: 15_000,
  });
}

export class UserMemoryContextService {
  private static instance: UserMemoryContextService | null = null;
  private readonly chatBootstrap = new Map<string, ChatBootstrapState>();

  static getInstance(): UserMemoryContextService {
    if (!UserMemoryContextService.instance) {
      UserMemoryContextService.instance = new UserMemoryContextService();
    }
    return UserMemoryContextService.instance;
  }

  /** Drop cached bootstrap when a chat is deleted. */
  clearChatBootstrap(chatId: string): void {
    this.chatBootstrap.delete(chatId);
  }

  /**
   * Whether the next user message will include deferred bootstrap blocks
   * (fetch already started or finished, not yet injected).
   */
  willInjectOnNextSend(chatId: string, history: unknown[]): boolean {
    const state = this.chatBootstrap.get(chatId);
    if (state && !state.injected && state.fetchPromise) {
      return true;
    }

    if (shouldBootstrapUserMemory(history) && state && !state.injected) {
      return Boolean(state.fetchPromise);
    }

    return false;
  }

  async getMemoryContextBlocks(
    chatId: string,
    userMessage: string,
    history: unknown[],
    options?: { mode?: MemoryBootstrapMode },
  ): Promise<string[]> {
    const mode = options?.mode ?? "stream";

    if (shouldBootstrapUserMemory(history)) {
      return this.handleBootstrapTriggerTurn(chatId, userMessage, mode);
    }

    return this.handleDeferredInjectionTurn(chatId, mode);
  }

  private handleBootstrapTriggerTurn(
    chatId: string,
    userMessage: string,
    mode: MemoryBootstrapMode,
  ): Promise<string[]> {
    let state = this.chatBootstrap.get(chatId);
    if (!state || state.injected) {
      state = createEmptyBootstrapState();
      this.chatBootstrap.set(chatId, state);
    }

    if (!state.fetchPromise) {
      state.fetchPromise = this.fetchMemoryContextBlocks(chatId, userMessage)
        .then((blocks) => {
          state.blocks = blocks;
          console.log(
            `[UserMemoryContext] Background bootstrap complete for chat ${chatId}: ${blocks.length} block(s)`,
          );
          return blocks;
        })
        .catch((error: unknown) => {
          console.warn(
            `[UserMemoryContext] Background bootstrap failed for chat ${chatId}:`,
            error,
          );
          state.blocks = [];
          return [];
        });
    }

    if (mode === "inspect") {
      return state.fetchPromise;
    }

    console.log(
      `[UserMemoryContext] Started background bootstrap for chat ${chatId} — not blocking first response`,
    );
    return Promise.resolve([]);
  }

  private async handleDeferredInjectionTurn(
    chatId: string,
    mode: MemoryBootstrapMode,
  ): Promise<string[]> {
    const state = this.chatBootstrap.get(chatId);
    if (!state || state.injected) {
      if (mode === "stream") {
        console.log(
          `[UserMemoryContext] No deferred bootstrap to inject for chat ${chatId}`,
        );
      }
      return [];
    }

    const blocks = await this.resolveDeferredBlocks(state);

    if (mode === "stream") {
      state.injected = true;
      if (blocks.length > 0) {
        console.log(
          `[UserMemoryContext] Injecting ${blocks.length} deferred memory block(s) for chat ${chatId}`,
        );
      } else {
        console.log(
          `[UserMemoryContext] Deferred bootstrap empty for chat ${chatId}`,
        );
      }
    }

    return blocks;
  }

  private async resolveDeferredBlocks(
    state: ChatBootstrapState,
  ): Promise<string[]> {
    if (state.blocks !== null) {
      return state.blocks;
    }
    if (state.fetchPromise) {
      return state.fetchPromise;
    }
    return [];
  }

  private async fetchMemoryContextBlocks(
    chatId: string,
    userMessage: string,
  ): Promise<string[]> {
    const userId = getPaprUserId();
    if (!userId) {
      console.log(
        `[UserMemoryContext] Skipping bootstrap for chat ${chatId} — no papr user_id`,
      );
      return [];
    }

    const client = await createPaprClient();
    if (!client) {
      console.log(
        `[UserMemoryContext] Skipping bootstrap for chat ${chatId} — no PAPR_API_KEY`,
      );
      return [];
    }

    console.log(
      `[UserMemoryContext] Fetching cross-chat memory for chat ${chatId}, user ${userId}`,
    );

    const { getApiKey: getSessionToken } = await import("../utils/keyResolver.js");
    const sessionToken = await getSessionToken("PAPR_SESSION_TOKEN");

    const [goalsResult, usecasesResult, tiersResult, searchResult] =
      await Promise.allSettled([
        sessionToken
          ? fetchParseGoalsForUser(sessionToken, userId)
          : Promise.resolve([]),
        sessionToken
          ? fetchParseUsecasesForUser(sessionToken, userId)
          : Promise.resolve([]),
        client.sync.getTiers({
          user_id: userId,
          max_tier0: MAX_TIER0,
          max_tier1: MAX_TIER1,
          include_embeddings: false,
        }),
        client.memory.search({
          query: userMessage,
          user_id: userId,
          max_memories: MAX_SEARCH_MEMORIES,
        }),
      ]);

    const blocks: string[] = [];

    if (goalsResult.status === "fulfilled") {
      const block = formatGoalsOkrsBlock(goalsResult.value);
      if (block) {
        blocks.push(block);
      }
    } else if (sessionToken) {
      console.warn(
        "[UserMemoryContext] Parse Goal fetch failed:",
        goalsResult.reason,
      );
    }

    if (usecasesResult.status === "fulfilled") {
      const block = formatUseCasesBlock(usecasesResult.value);
      if (block) {
        blocks.push(block);
      }
    } else if (sessionToken) {
      console.warn(
        "[UserMemoryContext] Parse Usecase fetch failed:",
        usecasesResult.reason,
      );
    }

    if (!sessionToken) {
      console.log(
        `[UserMemoryContext] Skipping Parse Goal/Usecase for chat ${chatId} — no PAPR_SESSION_TOKEN`,
      );
    }

    if (tiersResult.status === "fulfilled") {
      const block = formatSyncTiersBlock(
        tiersResult.value.tier0 ?? [],
        tiersResult.value.tier1 ?? [],
      );
      if (block) {
        blocks.push(block);
      }
    } else {
      console.warn(
        "[UserMemoryContext] sync.getTiers failed:",
        tiersResult.reason,
      );
    }

    if (searchResult.status === "fulfilled") {
      const block = formatMessageSearchBlock(
        searchResult.value.data?.memories ?? [],
      );
      if (block) {
        blocks.push(block);
      }
    } else {
      console.warn(
        "[UserMemoryContext] memory.search failed:",
        searchResult.reason,
      );
    }

    return blocks;
  }

  /**
   * Fetch bootstrap blocks for the sleep cycle (goals, use cases, memory tiers, search).
   * Same sources as chat-start bootstrap, with a sleep-specific memory search query.
   */
  async fetchSleepBootstrapBlocks(): Promise<string[]> {
    const sleepQuery =
      "Recent user goals OKRs use cases decisions preferences workflow patterns project updates lessons learned from conversations and jobs";
    return this.fetchMemoryContextBlocks("sleep-cycle", sleepQuery);
  }
}

export function getUserMemoryContextService(): UserMemoryContextService {
  return UserMemoryContextService.getInstance();
}
