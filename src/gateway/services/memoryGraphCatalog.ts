/**
 * Memory Graph Catalog — local wiki (sync) + Papr sync tiers (deferred).
 * Wiki injects on chat-start turn 1; Papr tiers/search inject on turn 2.
 */

import type { MemoryObject } from "@papr/memory/resources/shared.js";
import type Papr from "@papr/memory";
import {
  fetchWikiHome,
  type WikiHomeResult,
  type WikiNode,
} from "./KnowledgeGraphWikiService.js";
import { getPaprUserId } from "../utils/paprUserId.js";

export const MAX_CATALOG_TIER0 = 20;
export const MAX_CATALOG_TIER1 = 25;
export const MAX_CATALOG_SEARCH_MEMORIES = 10;
export const CATALOG_SYNC_TIERS_TIMEOUT_MS = 60_000;

/** Injected synchronously on chat-start turn 1 (local entity files). */
export const WIKI_GRAPH_CATALOG_PREFIX =
  "[WIKI GRAPH — local entity index; use get_wiki_entity for full pages]";

/** Injected on turn 2 after background Papr fetch completes. */
export const PAPR_MEMORY_CATALOG_PREFIX =
  "[PAPR MEMORY CATALOG — priority memories matched to your workspace]";

/** @deprecated Combined prefix — use WIKI_GRAPH + PAPR_MEMORY split blocks. */
export const MEMORY_GRAPH_CATALOG_PREFIX = WIKI_GRAPH_CATALOG_PREFIX;

export const MAX_WIKI_CATALOG_CHARS = 12_000;
export const MAX_PAPR_CATALOG_CHARS = 4500;
/** Names-only rails — include all entities (typical workspaces have dozens, not thousands). */
export const CATALOG_WIKI_ITEMS_PER_RAIL = 200;
export const CATALOG_TIER_ITEMS = 8;
export const CATALOG_RELATED_ITEMS = 6;
export const CATALOG_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export interface MemoryGraphCatalogSnapshot {
  fetchedAt: number;
  wiki: WikiHomeResult;
  tier0: MemoryObject[];
  tier1: MemoryObject[];
}

export interface PaprCatalogSnapshot {
  fetchedAt: number;
  tier0: MemoryObject[];
  tier1: MemoryObject[];
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.substring(0, maxChars)}...`;
}

function formatWikiNodeLineCompact(node: WikiNode): string {
  return `- **${node.label}** (\`${node.id}\`)`;
}

function collectWikiNodes(wiki: WikiHomeResult): WikiNode[] {
  const seen = new Set<string>();
  const nodes: WikiNode[] = [];
  for (const rail of wiki.rails) {
    for (const item of rail.items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      nodes.push(item);
    }
  }
  return nodes;
}

/** Match entity labels/ids against tokens in the user's message (e.g. "patrick"). */
export function findWikiEntitiesMatchingQuery(
  wiki: WikiHomeResult,
  userMessage: string,
): WikiNode[] {
  const tokens = userMessage
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) {
    return [];
  }

  return collectWikiNodes(wiki).filter((node) => {
    const label = node.label.toLowerCase();
    const id = node.id.toLowerCase();
    return tokens.some(
      (token) => label.includes(token) || id.includes(token.replace(/\s+/g, "-")),
    );
  });
}

function formatWikiMatchedSection(matches: WikiNode[]): string[] {
  if (matches.length === 0) {
    return [];
  }
  const lines: string[] = [
    "### Matched to your message",
    ...matches.map(formatWikiNodeLineCompact),
  ];
  return lines;
}

function formatWikiSection(wiki: WikiHomeResult): string[] {
  if (!wiki.configured || wiki.rails.length === 0) {
    return [];
  }

  const lines: string[] = ["### Wiki graph (entities — use get_wiki_entity for details)"];
  if (wiki.featured) {
    lines.push(
      `Featured: **${wiki.featured.label}** (\`${wiki.featured.id}\`)`,
    );
  }

  for (const rail of wiki.rails) {
    if (rail.items.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`**${rail.title}** (${rail.items.length})`);
    for (const item of rail.items.slice(0, CATALOG_WIKI_ITEMS_PER_RAIL)) {
      lines.push(formatWikiNodeLineCompact(item));
    }
    if (rail.items.length > CATALOG_WIKI_ITEMS_PER_RAIL) {
      lines.push(
        `- … +${rail.items.length - CATALOG_WIKI_ITEMS_PER_RAIL} more (${rail.title.toLowerCase()})`,
      );
    }
  }

  return lines;
}

function formatTierSection(
  title: string,
  memories: MemoryObject[],
  maxItems: number,
): string[] {
  if (memories.length === 0) {
    return [];
  }

  const lines: string[] = [`### ${title}`];
  for (const mem of memories.slice(0, maxItems)) {
    const category = mem.category ? `[${mem.category}] ` : "";
    const idPart = mem.id ? ` (memoryId: \`${mem.id}\`)` : "";
    const preview = truncateText(
      (mem.content ?? "").replace(/\s+/g, " ").trim(),
      180,
    );
    lines.push(`- ${category}${preview}${idPart}`);
  }
  if (memories.length > maxItems) {
    lines.push(`- … +${memories.length - maxItems} more`);
  }
  return lines;
}

function formatRelatedSection(memories: MemoryObject[]): string[] {
  if (memories.length === 0) {
    return [];
  }

  const lines: string[] = ["### Matched to current message (semantic)"];
  for (const mem of memories.slice(0, CATALOG_RELATED_ITEMS)) {
    const category = mem.category ? `[${mem.category}] ` : "";
    const idPart = mem.id ? ` (memoryId: \`${mem.id}\`)` : "";
    const preview = truncateText(
      (mem.content ?? "").replace(/\s+/g, " ").trim(),
      160,
    );
    lines.push(`- ${category}${preview}${idPart}`);
  }
  if (memories.length > CATALOG_RELATED_ITEMS) {
    lines.push(`- … +${memories.length - CATALOG_RELATED_ITEMS} more`);
  }
  return lines;
}

/** Sync-friendly: reads local entity files (~ms). Safe without Papr API key. */
export async function fetchLocalWikiHome(): Promise<WikiHomeResult> {
  return fetchWikiHome();
}

export function buildWikiGraphCatalogBlock(input: {
  wiki: WikiHomeResult;
  userMessage?: string;
}): string | undefined {
  const sections: string[] = [];

  if (input.userMessage) {
    sections.push(
      ...formatWikiMatchedSection(
        findWikiEntitiesMatchingQuery(input.wiki, input.userMessage),
      ),
    );
  }
  sections.push(...formatWikiSection(input.wiki));

  const body = sections.filter((line) => line.length > 0).join("\n");
  if (!body.trim()) {
    return undefined;
  }

  let block = `${WIKI_GRAPH_CATALOG_PREFIX}

${body}

**Entity details:** \`get_wiki_entity({ entityId: "person/patrick-hartigan" })\` or \`get_wiki_entity({ name: "Patrick" })\``;

  if (block.length > MAX_WIKI_CATALOG_CHARS) {
    block = `${block.substring(0, MAX_WIKI_CATALOG_CHARS)}\n[... wiki catalog truncated — use get_wiki_entity or search_wiki_entities]`;
  }

  return block;
}

export function buildPaprMemoryCatalogBlock(input: {
  tier0: MemoryObject[];
  tier1: MemoryObject[];
  relatedMemories?: MemoryObject[];
}): string | undefined {
  const sections: string[] = [];

  sections.push(
    ...formatTierSection(
      "Papr Memory — priority (tier 0)",
      input.tier0,
      CATALOG_TIER_ITEMS,
    ),
  );
  sections.push(
    ...formatTierSection(
      "Papr Memory — recent hot (tier 1)",
      input.tier1,
      CATALOG_TIER_ITEMS,
    ),
  );
  if (input.relatedMemories && input.relatedMemories.length > 0) {
    sections.push(...formatRelatedSection(input.relatedMemories));
  }

  const body = sections.filter((line) => line.length > 0).join("\n");
  if (!body.trim()) {
    return undefined;
  }

  let block = `${PAPR_MEMORY_CATALOG_PREFIX}

${body}

**Go deeper:**
- Full text: \`search_agent_memory({ memoryId: "..." })\`
- Graph traverse: \`query_memory_graph({ query: "..." })\` (use \`introspect_memory_graph\` for schema)`;

  if (block.length > MAX_PAPR_CATALOG_CHARS) {
    block = `${block.substring(0, MAX_PAPR_CATALOG_CHARS)}\n[... catalog truncated — use search_agent_memory for more]`;
  }

  return block;
}

/** Combined block for inspect mode / legacy callers. */
export function buildMemoryGraphCatalogBlock(input: {
  wiki: WikiHomeResult;
  tier0: MemoryObject[];
  tier1: MemoryObject[];
  relatedMemories?: MemoryObject[];
  userMessage?: string;
}): string | undefined {
  const wikiBlock = buildWikiGraphCatalogBlock({
    wiki: input.wiki,
    userMessage: input.userMessage,
  });
  const paprBlock = buildPaprMemoryCatalogBlock({
    tier0: input.tier0,
    tier1: input.tier1,
    relatedMemories: input.relatedMemories,
  });

  if (!wikiBlock && !paprBlock) {
    return undefined;
  }
  if (wikiBlock && paprBlock) {
    return `${wikiBlock}\n\n${paprBlock}`;
  }
  return wikiBlock ?? paprBlock;
}

export function isWikiGraphCatalogBlock(content: string): boolean {
  return content.startsWith(WIKI_GRAPH_CATALOG_PREFIX);
}

export function isPaprMemoryCatalogBlock(content: string): boolean {
  return content.startsWith(PAPR_MEMORY_CATALOG_PREFIX);
}

export function isMemoryGraphCatalogBlock(content: string): boolean {
  return (
    isWikiGraphCatalogBlock(content) || isPaprMemoryCatalogBlock(content)
  );
}

export async function fetchPaprCatalogSnapshot(
  client: Papr,
  userId: string,
): Promise<PaprCatalogSnapshot | null> {
  try {
    const tiersResult = await client.sync.getTiers(
      {
        external_user_id: userId,
        max_tier0: MAX_CATALOG_TIER0,
        max_tier1: MAX_CATALOG_TIER1,
        include_embeddings: false,
      },
      { timeout: CATALOG_SYNC_TIERS_TIMEOUT_MS },
    );
    const tier0 = tiersResult.tier0 ?? [];
    const tier1 = tiersResult.tier1 ?? [];
    if (tier0.length === 0 && tier1.length === 0) {
      return null;
    }
    return {
      fetchedAt: Date.now(),
      tier0,
      tier1,
    };
  } catch (error) {
    console.warn("[MemoryGraphCatalog] sync.getTiers failed:", error);
    return null;
  }
}

export async function fetchCatalogSnapshot(
  client: Papr,
  userId: string,
): Promise<MemoryGraphCatalogSnapshot | null> {
  const [wikiResult, paprSnapshot] = await Promise.all([
    fetchWikiHome(),
    fetchPaprCatalogSnapshot(client, userId),
  ]);

  const wiki = wikiResult;
  const tier0 = paprSnapshot?.tier0 ?? [];
  const tier1 = paprSnapshot?.tier1 ?? [];

  if (
    !wiki.configured &&
    tier0.length === 0 &&
    tier1.length === 0 &&
    wiki.rails.length === 0
  ) {
    return null;
  }

  return {
    fetchedAt: Date.now(),
    wiki,
    tier0,
    tier1,
  };
}

export async function fetchMessageRelatedMemories(
  client: Papr,
  userId: string,
  userMessage: string,
): Promise<MemoryObject[]> {
  const response = await client.memory.search({
    query: userMessage,
    external_user_id: userId,
    max_memories: MAX_CATALOG_SEARCH_MEMORIES,
  });

  const root = response as {
    data?: { memories?: MemoryObject[] };
    memories?: MemoryObject[];
  };
  return root.data?.memories ?? root.memories ?? [];
}

export async function createPaprClientForCatalog(): Promise<{
  client: Papr;
  userId: string;
} | null> {
  const userId = getPaprUserId();
  if (!userId) {
    return null;
  }

  const { getApiKey } = await import("../utils/keyResolver.js");
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    return null;
  }

  const PaprClient = (await import("@papr/memory")).default;
  return {
    userId,
    client: new PaprClient({
      xAPIKey: apiKey,
      maxRetries: 1,
      timeout: CATALOG_SYNC_TIERS_TIMEOUT_MS,
    }),
  };
}
