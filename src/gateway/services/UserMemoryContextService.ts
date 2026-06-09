/**
 * UserMemoryContextService - Chat-start cross-chat memory bootstrap
 *
 * On new chats or after ~2h idle, prefetches sync tiers + message-scoped search
 * and injects labeled context blocks into the model prompt.
 */

import Papr from "@papr/memory";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import { getPaprUserId } from "../utils/paprUserId.js";

export const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const MAX_TIER0 = 20;
export const MAX_TIER1 = 25;
export const MAX_SEARCH_MEMORIES = 8;
export const MAX_MEMORY_CHAR_PER_ITEM = 400;
export const MAX_BLOCK_CHARS = 3500;

interface HistoryMessageLike {
  role?: unknown;
  message_role?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
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

export function formatSyncTiersBlock(
  tier0: MemoryObject[],
  tier1: MemoryObject[],
): string | undefined {
  if (tier0.length === 0 && tier1.length === 0) {
    return undefined;
  }

  const lines: string[] = [];

  if (tier0.length > 0) {
    lines.push("**Goals / OKRs / Use cases (Tier 0):**");
    for (const memory of tier0) {
      lines.push(formatMemoryLine(memory));
    }
  }

  if (tier1.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**Hot memories (Tier 1):**");
    for (const memory of tier1) {
      lines.push(formatMemoryLine(memory));
    }
  }

  let body = lines.join("\n");
  if (body.length > MAX_BLOCK_CHARS) {
    body = `${body.substring(0, MAX_BLOCK_CHARS)}\n[... truncated]`;
  }

  return `[CROSS-CHAT USER CONTEXT — background from other conversations; may not reflect your current task]

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

  return `[RELATED MEMORY — matched to the user's current message]

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

  static getInstance(): UserMemoryContextService {
    if (!UserMemoryContextService.instance) {
      UserMemoryContextService.instance = new UserMemoryContextService();
    }
    return UserMemoryContextService.instance;
  }

  async getMemoryContextBlocks(
    chatId: string,
    userMessage: string,
    history: unknown[],
  ): Promise<string[]> {
    if (!shouldBootstrapUserMemory(history)) {
      console.log(
        `[UserMemoryContext] Skipping bootstrap for chat ${chatId} — active conversation`,
      );
      return [];
    }

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
      `[UserMemoryContext] Bootstrapping cross-chat memory for chat ${chatId}, user ${userId}`,
    );

    const [tiersResult, searchResult] = await Promise.allSettled([
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

    console.log(
      `[UserMemoryContext] Injected ${blocks.length} memory block(s) for chat ${chatId}`,
    );

    return blocks;
  }
}

export function getUserMemoryContextService(): UserMemoryContextService {
  return UserMemoryContextService.getInstance();
}
