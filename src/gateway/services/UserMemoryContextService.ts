/**
 * UserMemoryContextService - Chat-start cross-chat memory bootstrap
 *
 * Turn 1 (bootstrap trigger): inject local wiki graph synchronously (~ms).
 * Background: Papr sync tiers, message search, goals/use cases (12–20s).
 * Turn 2: inject deferred Papr blocks when background fetch completes.
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
import {
  buildPaprMemoryCatalogBlock,
  buildWikiGraphCatalogBlock,
  CATALOG_SNAPSHOT_TTL_MS,
  createPaprClientForCatalog,
  fetchLocalWikiHome,
  fetchMessageRelatedMemories,
  CATALOG_SYNC_TIERS_TIMEOUT_MS,
  fetchPaprCatalogSnapshot,
  isMemoryGraphCatalogBlock,
  isPaprMemoryCatalogBlock,
  isWikiGraphCatalogBlock,
  type PaprCatalogSnapshot,
} from "./memoryGraphCatalog.js";
import {
  fetchSyncTiersThrottled,
  seedSyncTiersFailureFromCache,
  SyncTiersBackoffError,
} from "./syncTiersClient.js";
import { shouldQueueMemoryPreviewRefresh } from "./MemoryPreviewCache.js";

export const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const MAX_TIER0 = 20;
export const MAX_TIER1 = 25;
/** Smaller limits for Settings preview — faster Papr sync.getTiers response */
export const SETTINGS_MAX_TIER0 = 10;
export const SETTINGS_MAX_TIER1 = 10;
/** Re-export for settings preview / tests — same as catalog bootstrap timeout. */
export const SYNC_TIERS_SDK_TIMEOUT_MS = CATALOG_SYNC_TIERS_TIMEOUT_MS;
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
  wikiInjected: boolean;
}

function createEmptyBootstrapState(): ChatBootstrapState {
  return { blocks: null, fetchPromise: null, injected: false, wikiInjected: false };
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
    content.startsWith(RELATED_MEMORY_PREFIX) ||
    isWikiGraphCatalogBlock(content) ||
    isPaprMemoryCatalogBlock(content) ||
    isMemoryGraphCatalogBlock(content)
  );
}

/** True when injected memory blocks already prime recall (catalog, related memories, etc.). */
export function memoryContextSatisfiesSearchGate(blocks: string[]): boolean {
  if (blocks.length === 0) {
    return false;
  }
  return blocks.some(
    (block) =>
      isWikiGraphCatalogBlock(block) ||
      isPaprMemoryCatalogBlock(block) ||
      isMemoryGraphCatalogBlock(block) ||
      block.startsWith(RELATED_MEMORY_PREFIX) ||
      block.startsWith(CROSS_CHAT_CONTEXT_PREFIX) ||
      block.startsWith(GOALS_OKRS_PREFIX) ||
      block.startsWith(USE_CASES_PREFIX),
  );
}

export function classifyMemoryBlock(
  block: string,
):
  | "parse_goals"
  | "parse_usecases"
  | "sync_tiers"
  | "related_memory"
  | "wiki_graph_catalog"
  | "papr_memory_catalog"
  | "memory_graph_catalog"
  | "unknown" {
  if (block.startsWith(GOALS_OKRS_PREFIX)) {
    return "parse_goals";
  }
  if (block.startsWith(USE_CASES_PREFIX)) {
    return "parse_usecases";
  }
  if (isWikiGraphCatalogBlock(block)) {
    return "wiki_graph_catalog";
  }
  if (isPaprMemoryCatalogBlock(block)) {
    return "papr_memory_catalog";
  }
  if (isMemoryGraphCatalogBlock(block)) {
    return "memory_graph_catalog";
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
    timeout: SYNC_TIERS_SDK_TIMEOUT_MS,
  });
}

export class UserMemoryContextService {
  private static instance: UserMemoryContextService | null = null;
  private readonly chatBootstrap = new Map<string, ChatBootstrapState>();
  private paprSnapshotCache: PaprCatalogSnapshot | null = null;
  private wikiHomeCache: Awaited<ReturnType<typeof fetchLocalWikiHome>> | null =
    null;
  private wikiHomeCacheAt = 0;
  private previewRefreshInFlight = false;

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

  /**
   * Local wiki index — synchronous on turn 1, no Papr API required.
   */
  private async buildImmediateWikiCatalogBlock(
    userMessage: string,
  ): Promise<string | undefined> {
    const now = Date.now();
    if (
      !this.wikiHomeCache ||
      now - this.wikiHomeCacheAt > CATALOG_SNAPSHOT_TTL_MS
    ) {
      this.wikiHomeCache = await fetchLocalWikiHome();
      this.wikiHomeCacheAt = now;
    }

    return buildWikiGraphCatalogBlock({
      wiki: this.wikiHomeCache,
      userMessage,
    });
  }

  /**
   * Papr tiers + message-scoped search — background only, injects turn 2.
   */
  private async fetchPaprMemoryCatalogBlock(
    userMessage: string,
  ): Promise<string | undefined> {
    const papr = await createPaprClientForCatalog();
    if (!papr) {
      return undefined;
    }

    const now = Date.now();
    let snapshot = this.paprSnapshotCache;
    if (!snapshot || now - snapshot.fetchedAt > CATALOG_SNAPSHOT_TTL_MS) {
      const fresh = await fetchPaprCatalogSnapshot(papr.client, papr.userId);
      if (fresh) {
        snapshot = fresh;
        this.paprSnapshotCache = fresh;
      }
    }

    let relatedMemories: MemoryObject[] = [];
    try {
      relatedMemories = await fetchMessageRelatedMemories(
        papr.client,
        papr.userId,
        userMessage,
      );
    } catch (error) {
      console.warn(
        "[UserMemoryContext] Catalog message search failed:",
        error,
      );
    }

    if (!snapshot && relatedMemories.length === 0) {
      return undefined;
    }

    return buildPaprMemoryCatalogBlock({
      tier0: snapshot?.tier0 ?? [],
      tier1: snapshot?.tier1 ?? [],
      relatedMemories,
    });
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
      state.fetchPromise = this.fetchDeferredMemoryContextBlocks(
        chatId,
        userMessage,
      )
        .then((blocks) => {
          state.blocks = blocks;
          console.log(
            `[UserMemoryContext] Background Papr bootstrap complete for chat ${chatId}: ${blocks.length} block(s)`,
          );
          return blocks;
        })
        .catch((error: unknown) => {
          console.warn(
            `[UserMemoryContext] Background Papr bootstrap failed for chat ${chatId}:`,
            error,
          );
          state.blocks = [];
          return [];
        });
    }

    if (mode === "inspect") {
      return Promise.all([
        this.buildImmediateWikiCatalogBlock(userMessage),
        state.fetchPromise,
      ]).then(([wikiBlock, deferredBlocks]) => {
        const combined: string[] = [];
        if (wikiBlock) {
          combined.push(wikiBlock);
        }
        combined.push(...deferredBlocks);
        return combined;
      });
    }

    return this.buildImmediateWikiCatalogBlock(userMessage).then((wikiBlock) => {
      state!.wikiInjected = Boolean(wikiBlock);
      if (wikiBlock) {
        console.log(
          `[UserMemoryContext] Injecting local wiki graph immediately for chat ${chatId}`,
        );
        return [wikiBlock];
      }
      console.log(
        `[UserMemoryContext] Started background Papr bootstrap for chat ${chatId} — no local wiki entities`,
      );
      return [];
    });
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

  private async fetchDeferredMemoryContextBlocks(
    chatId: string,
    userMessage: string,
  ): Promise<string[]> {
    const userId = getPaprUserId();
    if (!userId) {
      console.log(
        `[UserMemoryContext] Skipping Papr bootstrap for chat ${chatId} — no papr user_id`,
      );
      return [];
    }

    const client = await createPaprClient();
    if (!client) {
      console.log(
        `[UserMemoryContext] Skipping Papr bootstrap for chat ${chatId} — no PAPR_API_KEY`,
      );
      return [];
    }

    console.log(
      `[UserMemoryContext] Fetching deferred Papr memory for chat ${chatId}, user ${userId}`,
    );

    const { getApiKey: getSessionToken } = await import("../utils/keyResolver.js");
    const sessionToken = await getSessionToken("PAPR_SESSION_TOKEN");

    const [catalogSettled, goalsSettled, usecasesSettled] =
      await Promise.allSettled([
        this.fetchPaprMemoryCatalogBlock(userMessage),
        sessionToken
          ? fetchParseGoalsForUser(sessionToken, userId)
          : Promise.resolve([]),
        sessionToken
          ? fetchParseUsecasesForUser(sessionToken, userId)
          : Promise.resolve([]),
      ]);

    const blocks: string[] = [];

    if (catalogSettled.status === "fulfilled" && catalogSettled.value) {
      blocks.push(catalogSettled.value);
    } else if (catalogSettled.status === "rejected") {
      console.warn(
        "[UserMemoryContext] Papr catalog fetch failed:",
        catalogSettled.reason,
      );
    }

    if (goalsSettled.status === "fulfilled") {
      const block = formatGoalsOkrsBlock(goalsSettled.value);
      if (block) {
        blocks.push(block);
      }
    } else if (sessionToken) {
      console.warn(
        "[UserMemoryContext] Parse Goal fetch failed:",
        goalsSettled.reason,
      );
    }

    if (usecasesSettled.status === "fulfilled") {
      const block = formatUseCasesBlock(usecasesSettled.value);
      if (block) {
        blocks.push(block);
      }
    } else if (sessionToken) {
      console.warn(
        "[UserMemoryContext] Parse Usecase fetch failed:",
        usecasesSettled.reason,
      );
    }

    if (!sessionToken) {
      console.log(
        `[UserMemoryContext] Skipping Parse Goal/Usecase for chat ${chatId} — no PAPR_SESSION_TOKEN`,
      );
    }

    void this.writeSettingsPreviewCacheFromBlocks(
      blocks,
      {
        paprConfigured: client !== null,
        paprUserId: userId ?? null,
        hasSessionToken: Boolean(sessionToken),
        isLoggedIn: client !== null,
      },
      this.paprSnapshotCache,
    );

    return blocks;
  }

  /** Sleep cycle + legacy alias — deferred Papr bootstrap sources. */
  private async fetchMemoryContextBlocks(
    chatId: string,
    userMessage: string,
  ): Promise<string[]> {
    return this.fetchDeferredMemoryContextBlocks(chatId, userMessage);
  }

  private async writeSettingsPreviewCacheFromBlocks(
    blocks: string[],
    statusBase: {
      paprConfigured: boolean;
      paprUserId: string | null;
      hasSessionToken: boolean;
      isLoggedIn: boolean;
    },
    catalogSnapshot?: PaprCatalogSnapshot | null,
  ): Promise<void> {
    try {
      let goalsOkrs: string | null = null;
      let useCases: string | null = null;
      let syncTiers: string | null = null;

      for (const block of blocks) {
        const kind = classifyMemoryBlock(block);
        if (kind === "parse_goals") {
          goalsOkrs = block;
        } else if (kind === "parse_usecases") {
          useCases = block;
        } else if (kind === "sync_tiers") {
          syncTiers = block;
        }
      }

      if (!syncTiers && catalogSnapshot) {
        syncTiers =
          formatSyncTiersBlock(
            catalogSnapshot.tier0,
            catalogSnapshot.tier1,
          ) ?? null;
      }

      const { writeMemoryPreviewCache } = await import(
        "./MemoryPreviewCache.js"
      );
      await writeMemoryPreviewCache({
        paprMemory: { goalsOkrs, useCases, syncTiers },
        status: {
          ...statusBase,
          errors: {},
          syncTiersFetched: Boolean(syncTiers || catalogSnapshot),
        },
        syncTiersFailedAt: syncTiers || catalogSnapshot ? null : undefined,
      });
    } catch (error) {
      console.warn(
        "[UserMemoryContext] Failed to warm memory preview cache:",
        error,
      );
    }
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

  /** Fast local status — no network calls (for instant Settings UI). */
  async buildQuickPreviewStatus(): Promise<{
    paprConfigured: boolean;
    paprUserId: string | null;
    hasSessionToken: boolean;
    isLoggedIn: boolean;
    errors: {
      goals?: string;
      useCases?: string;
      syncTiers?: string;
    };
  }> {
    const { getApiKey } = await import("../utils/keyResolver.js");
    const apiKey = await getApiKey("PAPR_API_KEY");
    const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
    const userId = getPaprUserId();
    const isLoggedIn = Boolean(apiKey);

    return {
      paprConfigured: isLoggedIn,
      paprUserId: userId ?? null,
      hasSessionToken: Boolean(sessionToken),
      isLoggedIn,
      errors: {},
    };
  }

  /**
   * Fetch Papr memory context for Settings preview (goals/OKRs, use cases, sync tiers).
   * Same sources as chat bootstrap, without message-scoped search.
   */
  async fetchMemoryPreviewForSettings(options?: {
    forceSyncTiers?: boolean;
  }): Promise<{
    goalsOkrs: string | null;
    useCases: string | null;
    syncTiers: string | null;
    status: {
      paprConfigured: boolean;
      paprUserId: string | null;
      hasSessionToken: boolean;
      isLoggedIn: boolean;
      errors: {
        goals?: string;
        useCases?: string;
        syncTiers?: string;
      };
      syncTiersFetched?: boolean;
    };
  }> {
    const { getApiKey } = await import("../utils/keyResolver.js");
    const apiKey = await getApiKey("PAPR_API_KEY");
    const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
    const userId = getPaprUserId();
    const client = apiKey
      ? await createPaprClient()
      : null;

    const isLoggedIn = Boolean(apiKey);
    const status = {
      paprConfigured: isLoggedIn,
      paprUserId: userId ?? null,
      hasSessionToken: Boolean(sessionToken),
      isLoggedIn,
      errors: {} as {
        goals?: string;
        useCases?: string;
        syncTiers?: string;
      },
      syncTiersFetched: false,
    };

    if (!isLoggedIn) {
      return {
        goalsOkrs: null,
        useCases: null,
        syncTiers: null,
        status,
      };
    }

    if (!userId || !client) {
      return {
        goalsOkrs: null,
        useCases: null,
        syncTiers: null,
        status,
      };
    }

    const withTimeout = <T>(
      promise: Promise<T>,
      label: string,
      timeoutMs: number,
    ): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(`${label} timed out after ${timeoutMs / 1000}s`),
              ),
            timeoutMs,
          );
        }),
      ]);

    const [goalsResult, usecasesResult] = await Promise.allSettled([
      sessionToken
        ? withTimeout(
            fetchParseGoalsForUser(sessionToken, userId),
            "Parse goals",
            12_000,
          )
        : Promise.resolve([]),
      sessionToken
        ? withTimeout(
            fetchParseUsecasesForUser(sessionToken, userId),
            "Parse use cases",
            12_000,
          )
        : Promise.resolve([]),
    ]);

    const tiersStarted = performance.now();
    let tiersResult:
      | { status: "fulfilled"; value: { tier0: MemoryObject[]; tier1: MemoryObject[] } }
      | { status: "rejected"; reason: unknown };

    try {
      const tiersValue = await fetchSyncTiersThrottled(
        client,
        userId,
        {
          max_tier0: SETTINGS_MAX_TIER0,
          max_tier1: SETTINGS_MAX_TIER1,
          include_embeddings: false,
        },
        {
          timeout: SYNC_TIERS_SDK_TIMEOUT_MS,
          force: options?.forceSyncTiers,
        },
      );
      tiersResult = { status: "fulfilled", value: tiersValue };
    } catch (reason) {
      tiersResult = { status: "rejected", reason };
    }

    if (tiersResult.status === "fulfilled") {
      console.log(
        `[UserMemoryContext] sync.getTiers OK in ${Math.round(performance.now() - tiersStarted)}ms (tier0=${tiersResult.value.tier0.length}, tier1=${tiersResult.value.tier1.length})`,
      );
    } else if (tiersResult.reason instanceof SyncTiersBackoffError) {
      console.warn(
        `[UserMemoryContext] sync.getTiers skipped (backoff active, retry in ${Math.ceil(tiersResult.reason.retryAfterMs / 1000)}s)`,
      );
    } else {
      console.warn(
        `[UserMemoryContext] sync.getTiers failed after ${Math.round(performance.now() - tiersStarted)}ms:`,
        tiersResult.reason,
      );
    }

    let goalsOkrs: string | null = null;
    let useCases: string | null = null;
    let syncTiers: string | null = null;

    if (goalsResult.status === "fulfilled") {
      goalsOkrs = formatGoalsOkrsBlock(goalsResult.value) ?? null;
    } else if (sessionToken) {
      status.errors.goals =
        goalsResult.reason instanceof Error
          ? goalsResult.reason.message
          : "Failed to fetch goals";
    }

    if (usecasesResult.status === "fulfilled") {
      useCases = formatUseCasesBlock(usecasesResult.value) ?? null;
    } else if (sessionToken) {
      status.errors.useCases =
        usecasesResult.reason instanceof Error
          ? usecasesResult.reason.message
          : "Failed to fetch use cases";
    }

    if (tiersResult.status === "fulfilled") {
      status.syncTiersFetched = true;
      syncTiers =
        formatSyncTiersBlock(
          tiersResult.value.tier0,
          tiersResult.value.tier1,
        ) ?? null;
    } else {
      status.errors.syncTiers =
        tiersResult.reason instanceof Error
          ? tiersResult.reason.message
          : "Failed to fetch sync tiers";
    }

    return { goalsOkrs, useCases, syncTiers, status };
  }

  /** Queue a background Settings preview refresh when cache is stale/incomplete. */
  maybeRefreshMemoryPreviewCacheInBackground(cached?: {
    isFresh: boolean;
    isIncomplete: boolean;
    syncTiersFailedAt?: string;
  }): void {
    if (
      cached &&
      !shouldQueueMemoryPreviewRefresh({
        isFresh: cached.isFresh,
        isIncomplete: cached.isIncomplete,
        syncTiersFailedAt: cached.syncTiersFailedAt,
        previewRefreshInFlight: this.previewRefreshInFlight,
      })
    ) {
      return;
    }
    if (this.previewRefreshInFlight) {
      return;
    }

    const userId = getPaprUserId();
    if (userId && cached?.syncTiersFailedAt) {
      seedSyncTiersFailureFromCache(userId, cached.syncTiersFailedAt);
    }

    this.previewRefreshInFlight = true;
    void this.fetchMemoryPreviewForSettings()
      .then(async (fresh) => {
        const { writeMemoryPreviewCache } = await import(
          "./MemoryPreviewCache.js"
        );
        const syncTiersFailedAt =
          fresh.status.errors.syncTiers !== undefined
            ? new Date().toISOString()
            : null;
        await writeMemoryPreviewCache({
          paprMemory: {
            goalsOkrs: fresh.goalsOkrs,
            useCases: fresh.useCases,
            syncTiers: fresh.syncTiers,
          },
          status: fresh.status,
          syncTiersFailedAt,
        });
        console.log("[UserMemoryContext] Memory preview cache refreshed");
      })
      .catch((error: unknown) => {
        console.warn(
          "[UserMemoryContext] Background memory preview refresh failed:",
          error,
        );
      })
      .finally(() => {
        this.previewRefreshInFlight = false;
      });
  }

  /** @deprecated Use maybeRefreshMemoryPreviewCacheInBackground instead. */
  refreshMemoryPreviewCacheInBackground(): void {
    this.maybeRefreshMemoryPreviewCacheInBackground();
  }
}

export function getUserMemoryContextService(): UserMemoryContextService {
  return UserMemoryContextService.getInstance();
}
