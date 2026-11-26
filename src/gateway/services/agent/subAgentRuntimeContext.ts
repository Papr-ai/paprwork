/**
 * Which injected memory blocks a sub-agent run keeps.
 *
 * The bootstrap returns a mix of blocks: the local wiki graph catalog, and the
 * Papr memory side (memory catalog, goals, use cases, cross-chat tiers, related
 * memory). A sub-agent profile can switch each side off independently.
 */
import { classifyMemoryBlock } from "../UserMemoryContextService.js";
import type { SubAgentRuntimeOptions } from "../../../core/types/subagents.js";

export function filterMemoryBlocksForRuntime(
  blocks: string[],
  runtime: Pick<Required<SubAgentRuntimeOptions>, "memoryContext" | "wikiContext">,
): string[] {
  if (runtime.memoryContext && runtime.wikiContext) return blocks;
  return blocks.filter((block) => {
    const isWiki = classifyMemoryBlock(block) === "wiki_graph_catalog";
    return isWiki ? runtime.wikiContext : runtime.memoryContext;
  });
}
