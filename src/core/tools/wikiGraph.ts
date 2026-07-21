/**
 * Wiki graph tools — local entity pages from ~/Papr/workspace/entities/
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchWikiEntity,
  searchLocalWikiEntities,
  type EntityFileNode,
  type WikiEntityResult,
  type WikiNode,
} from "../../gateway/services/KnowledgeGraphWikiService.js";

const getWikiEntitySchema = z.object({
  entityId: z
    .string()
    .optional()
    .describe(
      'Full entity id, e.g. "person/patrick-hartigan" (from WIKI GRAPH catalog)',
    ),
  type: z
    .string()
    .optional()
    .describe('Entity type when using slug id: person, company, project, app, learning, collection'),
  id: z
    .string()
    .optional()
    .describe('Entity slug without type prefix, e.g. "patrick-hartigan"'),
  name: z
    .string()
    .optional()
    .describe(
      'Search by display name when entityId is unknown, e.g. "Patrick" or "Patrick Hartigan"',
    ),
});

const searchWikiEntitiesSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Name or keyword to match against wiki entity labels and ids"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max matches to return (default 20)"),
});

function isEntityFileNode(node: WikiNode): node is EntityFileNode {
  return "sections" in node && "markdownBody" in node;
}

function formatEntitySummary(node: WikiNode): string {
  const description = node.description?.trim();
  return description
    ? `- **${node.label}** (\`${node.id}\`) — ${description}`
    : `- **${node.label}** (\`${node.id}\`)`;
}

function formatEntityDetail(result: WikiEntityResult): Record<string, unknown> {
  if (!result.node) {
    return {
      success: false,
      error: result.error ?? "Entity not found",
    };
  }

  const node = result.node;
  const detail: Record<string, unknown> = {
    success: true,
    entityId: node.id,
    type: node.type,
    label: node.label,
    description: node.description,
    props: node.props,
  };

  if (isEntityFileNode(node)) {
    if (node.sections["Context & Background"]) {
      detail.context = node.sections["Context & Background"];
    }
    if (node.sections["Key Details"]) {
      detail.keyDetails = node.sections["Key Details"];
    }
    if (node.sections["Key Observations (Audit Evidence)"]) {
      detail.keyObservations = node.sections["Key Observations (Audit Evidence)"];
    }
    if (node.relationships.length > 0) {
      detail.relationships = node.relationships;
    }
    if (node.evidence.length > 0) {
      detail.evidence = node.evidence;
    }
    if (!detail.context && node.markdownBody.trim()) {
      detail.body = node.markdownBody.trim();
    }
  }

  if (result.edges.length > 0) {
    detail.edges = result.edges;
  }
  if (result.rails.length > 0) {
    detail.relatedEntities = result.rails.map((rail) => ({
      title: rail.title,
      items: rail.items.map((item) => ({
        id: item.id,
        label: item.label,
        type: item.type,
      })),
    }));
  }
  if (result.relatedMemories && result.relatedMemories.length > 0) {
    detail.relatedMemories = result.relatedMemories;
  }

  return detail;
}

function parseEntityId(entityId: string): { wikiType: string; slug: string } {
  const parts = entityId.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return {
      wikiType: parts[parts.length - 2],
      slug: parts[parts.length - 1],
    };
  }
  return { wikiType: parts[0] ?? "person", slug: parts[0] ?? entityId };
}

export const getWikiEntityTool = createTool({
  id: "get_wiki_entity",
  description:
    "Fetch a full wiki entity page (person, company, project, app…) from the local knowledge graph. " +
    "Use when the user asks about someone or something by name — BEFORE saying you have no memory. " +
    "Pass entityId from the WIKI GRAPH catalog, or name to search. Returns relationships, evidence, and narrative context.",
  inputSchema: getWikiEntitySchema,
  execute: async (inputData): Promise<Record<string, unknown>> => {
    const args = (inputData as { context?: z.infer<typeof getWikiEntitySchema> })
      .context ?? (inputData as z.infer<typeof getWikiEntitySchema>);

    if (args.entityId) {
      const { wikiType, slug } = parseEntityId(args.entityId);
      const result = await fetchWikiEntity(wikiType, slug, args.name);
      return formatEntityDetail(result);
    }

    if (args.type && args.id) {
      const result = await fetchWikiEntity(args.type, args.id, args.name);
      return formatEntityDetail(result);
    }

    if (args.name) {
      const matches = searchLocalWikiEntities(args.name);
      if (matches.length === 0) {
        return {
          success: false,
          error: `No wiki entity found matching "${args.name}". Try search_wiki_entities for broader lookup.`,
        };
      }
      if (matches.length > 1) {
        return {
          success: true,
          multipleMatches: true,
          matches: matches.map((node) => ({
            entityId: node.id,
            label: node.label,
            type: node.type,
            description: node.description,
          })),
          message:
            "Multiple entities matched — call get_wiki_entity again with a specific entityId.",
        };
      }

      const match = matches[0];
      const { wikiType, slug } = parseEntityId(match.id);
      const result = await fetchWikiEntity(wikiType, slug, match.label);
      return formatEntityDetail(result);
    }

    return {
      success: false,
      error: "Provide entityId, type+id, or name.",
    };
  },
});

export const searchWikiEntitiesTool = createTool({
  id: "search_wiki_entities",
  description:
    "Search the local wiki graph entity index by name or keyword. " +
    "Returns matching entity ids — follow up with get_wiki_entity for full details. " +
    "Instant local search (no Papr API latency).",
  inputSchema: searchWikiEntitiesSchema,
  execute: async (inputData): Promise<Record<string, unknown>> => {
    const args = (
      inputData as { context?: z.infer<typeof searchWikiEntitiesSchema> }
    ).context ?? (inputData as z.infer<typeof searchWikiEntitiesSchema>);

    const limit = args.limit ?? 20;
    const matches = searchLocalWikiEntities(args.query).slice(0, limit);

    return {
      success: true,
      query: args.query,
      count: matches.length,
      matches: matches.map((node) => ({
        entityId: node.id,
        label: node.label,
        type: node.type,
        summary: formatEntitySummary(node),
      })),
      message:
        matches.length > 0
          ? "Use get_wiki_entity({ entityId }) for full entity pages."
          : "No local wiki entities matched. Try search_agent_memory for Papr memories.",
    };
  },
});

export const wikiGraphTools = [getWikiEntityTool, searchWikiEntitiesTool];
