import Papr from "@papr/memory";
import type { FeedbackSubmitParams } from "@papr/memory/resources/feedback.js";
import type { SearchResponse } from "@papr/memory/resources/memory.js";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import type { SchemaListResponse, UserGraphSchemaOutput as Schema, SchemaCreateParams, SchemaUpdateParams } from "@papr/memory/resources/schemas.js";
import {
  buildAddPolicy,
  buildSearchPolicy,
} from "../../gateway/utils/paprMemoryPolicy.js";
import { buildAgentMemoryAddPolicy } from "../../gateway/utils/workspaceContextSchema.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  CURRENT_CHAT_SCOPE,
  resolveConversationId,
} from "./chatScope.js";
import { getCurrentChatId } from "./context.js";
import { getPaprClient, handlePaprToolError, isPaprNotFoundError } from "./paprClient.js";
import { assertValidWikiGraphQLSelection } from "../../gateway/services/wikiGraphqlUtils.js";
import {
  buildGraphReadOrderNote,
  listSchemasForGraphRead,
} from "../utils/memoryGraphSchemaRead.js";

const memoryReadAclToolFields = {
  readAcl: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional read ACL principals. Use external_user:{Parse objectId}, namespace:{namespaceId}, or organization:{orgId}. " +
        "When set, overrides the chat Team/Org scope for read access. Writer always keeps write ACL.",
    ),
  shareWithUserIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Parse objectIds (same as external_user_id / list_namespace_users.externalUserId) to grant read access. " +
        "Converted to external_user:{id} ACL principals automatically.",
    ),
  shareWithTeam: z
    .boolean()
    .optional()
    .describe(
      "When true with explicit ACL fields, also grant namespace read ACL for the active namespace.",
    ),
  shareWithOrganization: z
    .boolean()
    .optional()
    .describe(
      "When true with explicit ACL fields, also grant organization read ACL for the active org.",
    ),
};

const addMemorySchema = z
  .object({
    content: z.string().min(1),
    // Writer resolved at runtime via getPaprUserId() — passed as external_user_id (Parse objectId).
    role: z.enum(["user", "assistant"]).optional(),
    category: z
      .enum([
        "preference",
        "task",
        "goal",
        "fact",
        "context",
        "skills",
        "learning",
      ])
      .optional(),
    // Agent/job attribution fields (stored in customMetadata)
    sourceAgentId: z.string().optional(),
    sourceAgentName: z.string().optional(),
    runId: z.string().optional(),
    jobId: z.string().optional(),
    chatId: z.string().optional(),
    workspaceId: z.string().optional(),
    ...memoryReadAclToolFields,
    signalDomain: z
      .string()
      .optional()
      .describe(
        "Optional signal domain for enhanced semantic encoding on add (e.g. 'general', 'code', 'cosqa'). " +
          "Omit for standard embedding. Use list_signal_domains to see built-in domains.",
      ),
  })
  .refine(
    (data) => {
      // PAPR API requires role when category is "context"
      if (data.category === "context" && !data.role) {
        return false;
      }
      return true;
    },
    {
      message:
        'When category is "context", role field is required (must be "user" or "assistant")',
      path: ["role"],
    },
  );

const customMetadataFilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

const searchMemorySchema = z
  .object({
  memoryId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fetch one memory by ID (full content). Use when you have an ID from document upload " +
        "or a prior search — omit query when using this.",
    ),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Detailed search query describing what you're looking for. MUST be 2-3 sentences " +
      "with specific details, context, and time frame. Use specific nouns over vague ones " +
      "(e.g. 'graph-aware embedding architecture' beats 'how it works'). " +
      "Examples: " +
      "'Find recurring customer complaints about API performance from the last month, focusing on timeout errors.' " +
      "'What decisions were made about the Audit Workbench scoring system? Include the 1-4 maturity scale and which database is canonical.' " +
      "'Papr architecture: graph-aware embeddings, predictive memory layer, technical design decisions.'",
    ),
  customMetadataFilters: z
    .record(z.string(), customMetadataFilterValueSchema)
    .optional()
    .describe(
      "Exact-match filters on memory customMetadata. Examples: " +
      '{ "content_type": "document_summary", "upload_id": "abc-123" }, ' +
      '{ "file_name": "report.pdf" }, { "chat_id": "uuid" }, { "source": "code_indexer" }. ' +
      "Combined with code filters (projectId, fileName, etc.) when both are set.",
    ),
  maxMemories: z
    .number()
    .int()
    .min(10)
    .max(30)
    .optional()
    .describe(
      "Number of memories to return (min 10, max 30). Default 20. " +
      "Use 25-30 for architecture/concept queries where breadth matters. " +
      "Use 10-15 for narrow lookups where you know exactly what you want.",
    ),
  category: z
    .enum([
      "preference", "task", "goal", "fact", "context",
      "skills", "learning", "code",
    ])
    .optional()
    .describe(
      "Filter by memory category (maps to Papr metadata.category). " +
      "User role: 'preference' (likes/dislikes), 'task', 'goal', 'fact', 'context'. " +
      "Assistant role: 'skills', 'learning', 'task', 'goal', 'fact', 'context'. " +
      "'preference' is user-only. 'skills'/'learning' are assistant-only. " +
      "'task'/'goal'/'fact'/'context' can be either role. " +
      "'code' — shortcut that sets category='learning' + source='code_indexer' for indexed code files.",
    ),
  role: z
    .enum(["user", "assistant"])
    .optional()
    .describe(
      "Filter by who generated the memory. 'user' = user-authored memories (preferences, tasks, goals). " +
      "'assistant' = agent-authored (learnings, skills, code index). " +
      "Omit to search both.",
    ),
  rerankingProvider: z
    .enum(["none", "cohere", "openai", "papr_enhanced", "papr_max"])
    .optional()
    .describe(
      "Reranking provider for result quality. " +
      "'none' — cosine similarity only (fastest, no reranking). " +
      "'cohere' — Cohere rerank-v3.5 cross-encoder (default if omitted). " +
      "'openai' — OpenAI reranking (gpt-5-nano or gpt-5-mini). " +
      "'papr_enhanced' — Papr graph rerank (uses knowledge graph structure). " +
      "'papr_max' — Papr graph rerank + cross-encoder + EGR (highest accuracy, slower). " +
      "Default is 'cohere' when omitted.",
    ),
  rerankingModel: z
    .string()
    .optional()
    .describe(
      "Model for cohere/openai providers. Cohere: 'rerank-v3.5' (default). " +
      "OpenAI: 'gpt-5-nano', 'gpt-5-mini'. Only relevant when rerankingProvider is 'cohere' or 'openai'.",
    ),
  rerankingDomainId: z
    .string()
    .optional()
    .describe(
      "Signal domain for papr_enhanced/papr_max providers (e.g. 'general', 'code', 'cosqa'). " +
      "Defaults to 'general'. Only relevant for Papr reranking providers.",
    ),
  projectId: z
    .string()
    .optional()
    .describe(
      "Filter code search to a specific app or job by its ID (e.g. 'app-my-dashboard' or a job UUID). " +
      "Use with category='code' to find code within a specific mini-app or job.",
    ),
  projectType: z
    .enum(["mini_app", "job"])
    .optional()
    .describe(
      "Filter code search by project type: 'mini_app' for apps, 'job' for jobs.",
    ),
  language: z
    .enum(["TypeScript", "JavaScript", "Python"])
    .optional()
    .describe("Filter code search by programming language."),
  fileName: z
    .string()
    .optional()
    .describe(
      "Filter code search by file name (e.g. 'app.ts', 'main.py'). Exact match on file_name metadata.",
    ),
  chatId: z
    .string()
    .optional()
    .describe(
      `Scope search to one conversation session. Use "${CURRENT_CHAT_SCOPE}" for the active chat, ` +
      "or pass an explicit chat UUID. Omit to search across all chats. " +
      "ALWAYS use this when recalling decisions/architecture from the current conversation.",
    ),
  vectorPolicy: z
    .object({
      domainId: z
        .string()
        .optional()
        .describe(
          "Signal domain for enhanced vector search (e.g. 'code', 'general', 'cosqa'). " +
            "When category='code', defaults to 'code' if omitted. Use list_signal_domains.",
        ),
      returnSignalScores: z
        .boolean()
        .optional()
        .describe(
          "Return per-signal-band score breakdown (e.g. primary_operation: 0.95) explaining ranking.",
        ),
      signalThresholds: z
        .record(z.string(), z.number())
        .optional()
        .describe(
          "Filter by minimum alignment per signal band. Example: { primary_operation: 0.8 }",
        ),
    })
    .optional()
    .describe(
      "Optional vector search policy. Omit for standard search; use category='code' for code search defaults.",
    ),
})
  .refine((data) => Boolean(data.memoryId) || Boolean(data.query), {
    message: "Provide memoryId (direct fetch) OR query (semantic search), not neither",
    path: ["query"],
  });

function formatMemoryByIdResponse(
  memoryId: string,
  response: unknown,
): { success: true; data: Record<string, unknown> } {
  const data = response as {
    data?: {
      memories?: Array<{
        id?: string;
        content?: string;
        customMetadata?: Record<string, unknown> | null;
      }>;
    };
    memories?: Array<{
      id?: string;
      content?: string;
      customMetadata?: Record<string, unknown> | null;
    }>;
  };

  const memories = data.data?.memories ?? data.memories ?? [];
  const formatted = memories
    .filter((m) => typeof m.content === "string" && m.content.length > 0)
    .map((m) => ({
      memoryId: m.id ?? memoryId,
      content: m.content ?? "",
      customMetadata: (m.customMetadata as Record<string, unknown> | null) ?? {},
    }));

  if (formatted.length === 0) {
    return {
      success: true,
      data: {
        memoryId,
        found: false,
        message:
          "No memory content yet — may still be processing. Try get_document_upload_status.",
        raw: response,
      },
    };
  }

  return {
    success: true,
    data: {
      memoryId,
      found: true,
      memories: formatted,
      totalLength: formatted.reduce((sum, m) => sum + m.content.length, 0),
    },
  };
}

export interface SearchAgentMemoryToolResult {
  success: true;
  searchId: string | null;
  memoryCount: number;
  nodeCount: number;
  /** Raw SDK payload — a TOON string when response_format="toon". */
  data: SearchResponse | string;
  /** Agent-visible reminder — include literal searchId for submit_memory_feedback */
  _memoryFeedbackReminder: string;
}

function buildMemoryFeedbackReminder(
  searchId: string | null,
  memoryCount: number,
): string {
  if (searchId === null) {
    return "No searchId returned — skip submit_memory_feedback for this search.";
  }

  if (memoryCount === 0) {
    return (
      `searchId="${searchId}" — search returned 0 memories; low-relevance feedback was auto-submitted. ` +
      `Call submit_memory_feedback only if you disagree.`
    );
  }

  return (
    `After evaluating these results, if retrieval was clearly helpful or clearly irrelevant, call:\n` +
    `submit_memory_feedback({ searchId: "${searchId}", feedbackType: "thumbs_up" | "thumbs_down" | "memory_relevance", citedMemoryIds: ["<memory-id-from-results>"] })\n` +
    `Skip feedback when results were mediocre or mixed. Wrong memory content → delete_memory or add_agent_memory.`
  );
}

/**
 * TOON responses arrive as a plain string in `data` (not a SearchResult object), so
 * `response.data?.memories` and `response.search_id` are both undefined. Recover the
 * counters from the TOON envelope: `memories[#25]:` / `nodes[#3]:` / `search_id: <uuid>`.
 */
function parseToonEnvelope(toon: string): {
  searchId: string | null;
  memoryCount: number;
  nodeCount: number;
} {
  const countOf = (key: string): number => {
    const match = toon.match(new RegExp(`${key}\\[#(\\d+)\\]`));
    return match ? Number.parseInt(match[1]!, 10) : 0;
  };
  const idMatch = toon.match(/^\s*search_id:\s*"?([0-9a-fA-F-]{36})"?/m);

  return {
    searchId: idMatch?.[1] ?? null,
    memoryCount: countOf("memories"),
    nodeCount: countOf("nodes"),
  };
}

export function formatSearchMemoryResponse(
  response: SearchResponse | string,
  headers?: Headers | Record<string, string>,
): SearchAgentMemoryToolResult {
  const structured: SearchResponse =
    typeof response === "string" ? {} : response;
  let memoryCount = structured.data?.memories?.length ?? 0;
  let nodeCount = structured.data?.nodes?.length ?? 0;
  let searchId = structured.search_id ?? null;

  // Preferred path: server sets X-Search-Id / X-Memory-Count / X-Node-Count on TOON responses.
  if (headers) {
    const get = (name: string): string | null =>
      headers instanceof Headers
        ? headers.get(name)
        : (headers[name] ?? headers[name.toLowerCase()] ?? null);

    const headerSearchId = get("X-Search-Id");
    if (!searchId && headerSearchId) searchId = headerSearchId;

    const headerMemoryCount = get("X-Memory-Count");
    if (memoryCount === 0 && headerMemoryCount) {
      memoryCount = Number.parseInt(headerMemoryCount, 10) || 0;
    }

    const headerNodeCount = get("X-Node-Count");
    if (nodeCount === 0 && headerNodeCount) {
      nodeCount = Number.parseInt(headerNodeCount, 10) || 0;
    }
  }

  // TOON responses are text/plain, so the SDK hands back the raw string as the whole
  // response body (not { data: SearchResult }). Recover counters from the TOON envelope.
  // Also handles a { data: "<toon>" } shape defensively.
  const toonBody =
    typeof response === "string"
      ? response
      : typeof structured.data === "string"
        ? (structured.data as unknown as string)
        : null;

  if (toonBody !== null) {
    const parsed = parseToonEnvelope(toonBody);
    if (!searchId) searchId = parsed.searchId;
    if (memoryCount === 0) memoryCount = parsed.memoryCount;
    if (nodeCount === 0) nodeCount = parsed.nodeCount;
  }

  return {
    success: true,
    searchId,
    memoryCount,
    nodeCount,
    data: response,
    _memoryFeedbackReminder: buildMemoryFeedbackReminder(searchId, memoryCount),
  };
}

export async function submitEmptySearchFeedback(
  client: Papr,
  searchId: string,
): Promise<void> {
  const { paprUserScope } = await import("../../gateway/utils/paprUserId.js");
  try {
    await client.feedback.submit({
      search_id: searchId,
      ...paprUserScope(),
      feedbackData: {
        feedbackSource: "inline",
        feedbackType: "memory_relevance",
        feedbackText: "Search returned zero memories for the query.",
        feedbackScore: 1,
      },
    });
  } catch (error) {
    console.warn("[search_agent_memory] Empty-search feedback failed:", error);
  }
}

// Property definition for node/relationship properties
const propertyDefinitionSchema = z.object({
  type: z.enum(['string', 'integer', 'float', 'boolean', 'array', 'datetime', 'object']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  enum_values: z.array(z.string()).max(15).optional(),
  min_length: z.number().optional(),
  max_length: z.number().optional(),
  min_value: z.number().optional(),
  max_value: z.number().optional(),
  pattern: z.string().optional(),
});

// Node type definition
const nodeTypeSchema = z.object({
  name: z.string().min(1).describe("Node type name (e.g., 'Company', 'Contact')"),
  label: z.string().min(1).describe("Display label for the node type"),
  description: z.string().optional(),
  properties: z.record(z.string(), propertyDefinitionSchema).optional().describe("Properties as a dictionary: { 'name': { type: 'string', required: true }, ... }"),
  resolution_policy: z.enum(['upsert', 'lookup']).optional().describe("'upsert' (create if not found) or 'lookup' (link only to existing)"),
  unique_identifiers: z.array(z.string()).optional().describe("Properties that uniquely identify this node (e.g., ['name', 'email'])"),
  color: z.string().optional(),
  icon: z.string().optional(),
});

// Relationship type definition
const relationshipTypeSchema = z.object({
  name: z.string().min(1).describe("Relationship name (e.g., 'WORKS_AT', 'MANAGES')"),
  label: z.string().min(1).describe("Display label for the relationship"),
  description: z.string().optional(),
  allowed_source_types: z.array(z.string()).min(1).describe("Which node types can be sources"),
  allowed_target_types: z.array(z.string()).min(1).describe("Which node types can be targets"),
  properties: z.record(z.string(), propertyDefinitionSchema).optional(),
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-many']).optional(),
  color: z.string().optional(),
});


// Preprocess: parse stringified JSON back to objects (framework serialization workaround)
const jsonPreprocess = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((val) => {
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
    return val;
}, schema) as unknown as T;

const registerSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  node_types: jsonPreprocess(z.record(z.string(), nodeTypeSchema)).optional().describe("Node types as a dictionary: { 'Company': { name: 'Company', label: 'Company', ... }, ... }"),
  relationship_types: jsonPreprocess(z.record(z.string(), relationshipTypeSchema)).optional().describe("Relationship types as a dictionary: { 'WORKS_AT': { name: 'WORKS_AT', ... }, ... }"),
  status: z.enum(['draft', 'active']).optional().describe("'draft' (default) or 'active' to immediately enable the schema"),
  scope: z.enum(['personal', 'workspace', 'namespace', 'organization']).optional().describe("Scope of the schema (default: 'namespace')"),
});

const listSchemasSchema = z.object({
  statusFilter: z
    .enum(["draft", "active", "deprecated", "archived"])
    .optional()
    .describe("Filter schemas by status"),
  workspaceId: z.string().optional().describe("Filter schemas by workspace ID"),
});

const getSchemasSchema = z.object({
  schemaId: z.string().min(1).describe("The schema ID to fetch (e.g. 'BNSv8YCQXJ')"),
});

const updateSchemaSchema = z.object({
  schemaId: z.string().min(1).describe("The schema ID to update"),
  name: z.string().optional(),
  description: z.string().optional(),
  node_types: jsonPreprocess(z.record(z.string(), nodeTypeSchema)).optional().describe("Updated node types dictionary (replaces existing)"),
  relationship_types: jsonPreprocess(z.record(z.string(), relationshipTypeSchema)).optional().describe("Updated relationship types dictionary (replaces existing)"),
  status: z.enum(['draft', 'active', 'deprecated', 'archived']).optional().describe("Update schema status"),
  scope: z.enum(['personal', 'workspace', 'namespace', 'organization']).optional(),
});

export const addAgentMemoryTool = createTool({
  id: "add_agent_memory",
  description:
    "Store a structured memory item in PAPR memory. IMPORTANT: When using category='context', you MUST provide role ('user' or 'assistant'). " +
    "For attendee-only sharing, call list_namespace_users first, match emails to externalUserId, then pass shareWithUserIds or readAcl with external_user:{objectId} principals. " +
    "Use external_user_id semantics (Parse objectId) — NOT Papr internal user_id.",
  inputSchema: addMemorySchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const { buildPaprMemoryWriteScope, withMemoryScopeMetadata } = await import(
        "../../gateway/utils/memoryScopeResolver.js"
      );
      const { spreadMemoryScopeUserIdentity } = await import(
        "../../core/utils/paprMemoryUserIdentity.js"
      );

      // Build customMetadata for fields not in the MemoryMetadata spec
      const customMetadata: Record<string, string> = {};
      if (args.sourceAgentId) customMetadata.sourceAgentId = args.sourceAgentId;
      if (args.sourceAgentName)
        customMetadata.sourceAgentName = args.sourceAgentName;
      if (args.runId) customMetadata.runId = args.runId;
      if (args.jobId) customMetadata.jobId = args.jobId;
      const resolvedChatId = resolveConversationId(
        args.chatId ?? getCurrentChatId() ?? undefined,
      );
      if (resolvedChatId) customMetadata.chatId = resolvedChatId;
      if (args.workspaceId) customMetadata.workspaceId = args.workspaceId;

      const addPolicy = await buildAgentMemoryAddPolicy({
        signalDomain: args.signalDomain,
      });

      const { resolveExplicitReadAclFromToolArgs } = await import(
        "../../gateway/utils/memoryScopeResolver.js"
      );

      const memoryScope = await buildPaprMemoryWriteScope({
        chatId: resolvedChatId,
        addPolicy,
        explicitReadAcl: resolveExplicitReadAclFromToolArgs(args),
      });

      const response = await client.memory.add({
        content: args.content,
        ...spreadMemoryScopeUserIdentity(memoryScope),
        ...(memoryScope.namespace_id
          ? { namespace_id: memoryScope.namespace_id }
          : {}),
        ...(memoryScope.policy ? { policy: memoryScope.policy } : {}),
        metadata: withMemoryScopeMetadata(
          {
            role: args.role,
            category: args.category,
            ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
          },
          memoryScope,
        ),
      });
      return { success: true, data: response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

const listNamespaceUsersSchema = z.object({
  emailQuery: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring filter on member email or display name.",
    ),
});

export const listNamespaceUsersTool = createTool({
  id: "list_namespace_users",
  description:
    "List Papr users in the active workspace/namespace team. Returns Parse objectIds as externalUserId " +
    "and ready-to-use memoryReadPrincipal values (external_user:{objectId}) for add_agent_memory and create_entities ACL. " +
    "Call before sharing memories with specific attendees.",
  inputSchema: listNamespaceUsersSchema,
  execute: async (args) => {
    try {
      const { listNamespaceUsersForAgent } = await import(
        "../../gateway/services/namespaceUsersService.js"
      );
      const result = await listNamespaceUsersForAgent();
      const query = args.emailQuery?.trim().toLowerCase();
      const members = query
        ? result.members.filter(
            (member) =>
              member.email.toLowerCase().includes(query) ||
              member.displayName.toLowerCase().includes(query),
          )
        : result.members;

      return {
        success: true,
        data: {
          ...result,
          members,
          idGuidance: {
            bodyField: "external_user_id",
            aclPrefix: "external_user:",
            examplePrincipal: members[0]?.memoryReadPrincipal,
          },
        },
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const searchAgentMemoryTool = createTool({
  id: "search_agent_memory",
  description:
    "Search or fetch Papr memories. Pass memoryId to get full content of one memory by ID " +
    "(from document upload or prior results). Pass query for semantic search (2-3 sentences). " +
    "Use customMetadataFilters for exact filters (upload_id, content_type, file_name, chat_id, etc.). " +
    `For THIS chat: chatId "${CURRENT_CHAT_SCOPE}". For code: category='code' + projectId/projectType/language/fileName.`,
  inputSchema: searchMemorySchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();

      if (args.memoryId) {
        const response = await client.memory.get(args.memoryId);
        return formatMemoryByIdResponse(args.memoryId, response);
      }

      const { paprMemorySearchScopeSpread } = await import(
        "../../gateway/utils/memoryScopeResolver.js"
      );
      const customMetadata: Record<string, string | number | boolean | string[]> = {
        ...(args.customMetadataFilters ?? {}),
      };
      if (args.projectId) customMetadata.project_id = args.projectId;
      if (args.projectType) customMetadata.project_type = args.projectType;
      if (args.language) customMetadata.language = args.language;
      if (args.fileName) customMetadata.file_name = args.fileName;
      if (args.category === "code") customMetadata.source = "code_indexer";

      const hasMetadataFilters = Object.keys(customMetadata).length > 0;

      const scopeChatId = resolveConversationId(
        args.chatId ?? getCurrentChatId() ?? undefined,
      );

      let conversationId: string | undefined;
      if (args.chatId) {
        conversationId = resolveConversationId(args.chatId);
        if (args.chatId === CURRENT_CHAT_SCOPE && !conversationId) {
          throw new Error(
            `chatId "${CURRENT_CHAT_SCOPE}" requires an active chat session. ` +
              "Pass an explicit chat UUID instead.",
          );
        }
      }

      const isCodeSearch = args.category === "code";

      // Build metadata filters matching SDK's MemoryMetadata shape
      const searchMetadata: {
        category?: "preference" | "task" | "goal" | "fact" | "context" | "skills" | "learning";
        role?: "user" | "assistant";
        conversationId?: string;
        customMetadata?: Record<string, string | number | boolean | string[]>;
      } = {};

      if (conversationId) {
        searchMetadata.conversationId = conversationId;
      }
      if (isCodeSearch) {
        searchMetadata.category = "learning";
        searchMetadata.role = "assistant";
      } else if (args.category && args.category !== "code") {
        searchMetadata.category = args.category;
      }
      if (args.role && !isCodeSearch) {
        searchMetadata.role = args.role;
      }
      if (hasMetadataFilters) {
        searchMetadata.customMetadata = customMetadata;
      }

      const searchPolicy = buildSearchPolicy({
        vectorPolicy: args.vectorPolicy,
        defaultDomain: isCodeSearch ? "code" : undefined,
      });

      const memorySearchSpread = await paprMemorySearchScopeSpread({
        chatId: scopeChatId,
      });

      // Pass reranking config directly from agent's chosen provider/model
      const chosenProvider = args.rerankingProvider ?? "cohere";
      const chosenModel = args.rerankingModel ?? (chosenProvider === "cohere" ? "rerank-v3.5" : undefined);

      // withResponse() exposes the raw Response so we can read the server's
      // X-Search-Id / X-Memory-Count / X-Node-Count headers. That is more robust
      // than regex-parsing the TOON body, which stays as a fallback for servers
      // that predate those headers.
      const { data: response, response: httpResponse } = await client.memory
        .search({
          query: args.query!,
          ...memorySearchSpread,
          max_memories: args.maxMemories ?? 20,
          max_nodes: 20,
          enable_agentic_graph: true,
          reranking_config: {
            reranking_enabled: chosenProvider !== "none",
            reranking_provider: chosenProvider,
            ...(chosenModel ? { reranking_model: chosenModel } : {}),
            ...(args.rerankingDomainId
              ? { domain_id: args.rerankingDomainId }
              : {}),
          },
          response_format: "toon",
          ...(searchPolicy ? { policy: searchPolicy } : {}),
          ...(Object.keys(searchMetadata).length > 0
            ? { metadata: searchMetadata }
            : {}),
        })
        .withResponse();
      const formatted = formatSearchMemoryResponse(
        response,
        httpResponse.headers,
      );
      // Only auto-submit low-relevance feedback when the server genuinely returned
      // nothing. memoryCount is now recovered from the TOON envelope, so a parse
      // failure must NOT be mistaken for a zero-result search — that would train
      // the ranker down on every successful query.
      const isGenuinelyEmpty =
        formatted.memoryCount === 0 && formatted.nodeCount === 0;
      if (formatted.searchId !== null && isGenuinelyEmpty) {
        void submitEmptySearchFeedback(client, formatted.searchId);
      }
      return formatted;
    } catch (error) {
      if (isPaprNotFoundError(error)) {
        return { success: true, data: { memories: [], nodes: [], message: "No relevant items found for this query." } };
      }
      handlePaprToolError(error);
    }
  },
});

export const registerSchemaTool = createTool({
  id: "register_schema",
  description:
    "Register a Papr memory schema with custom entity types and relationships. " +
    "Creates node types (entities like Company, Contact) and relationship types (connections like WORKS_AT, MANAGES). " +
    "Pass node_types and relationship_types as dictionaries to create a fully functional schema. " +
    "Set status='active' to immediately enable the schema, or leave as 'draft' (default) to save without activating.",
  inputSchema: registerSchemaSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      
      // Build the create params using the SDK's type
      const createParams: SchemaCreateParams = {
        name: args.name,
        ...(args.description && { description: args.description }),
        ...(args.node_types && { node_types: args.node_types as SchemaCreateParams['node_types'] }),
        ...(args.relationship_types && { relationship_types: args.relationship_types as SchemaCreateParams['relationship_types'] }),
        ...(args.status && { status: args.status }),
        ...(args.scope && { scope: args.scope }),
      };
      
      const response = await client.schemas.create(createParams);
      
      // Extract schema ID from response
      const schemaId = (response as any).data?.id || (response as any).schema_id;
      
      return { 
        success: true, 
        data: response,
        message: args.node_types 
          ? `Schema registered with ${Object.keys(args.node_types).length} node types. Schema ID: ${schemaId}` 
          : `Schema shell created. Use update or pass node_types to add entity types. Schema ID: ${schemaId}`
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const listSchemasTool = createTool({
  id: "list_schemas",
  description:
    "List KNOWLEDGE GRAPH schemas (user-created entity/relationship schemas). Returns schemas with node types and relationships. " +
    "WorkspaceContext is the primary schema for wiki/sleep reads — query its GraphQL types first. " +
    "Use get_schema to fetch full details (node types, relationships, properties) for a specific schema. " +
    "⚠️ NOTE: For signal domains (vector/transform policy), use list_signal_domains instead.",
  inputSchema: listSchemasSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.schemas.list({
        status_filter: args.statusFilter,
        workspace_id: args.workspaceId,
      });
      
      // Return lightweight summary (just name, ID, description, status)
      // This prevents truncation when there are many schemas
      const responseData = response as SchemaListResponse;
      const summary = responseData.data?.map((schema: Schema) => ({
        id: schema.id,
        name: schema.name,
        description: schema.description,
        status: schema.status,
        version: schema.version,
        nodeTypeCount: schema.node_types?.length ?? 0,
        relationshipCount: schema.relationship_types?.length ?? 0,
      })) ?? [];
      
      return { 
        success: true, 
        data: {
          count: summary.length,
          schemas: summary,
          note: "Use get_schema(schemaId) to fetch full details for a specific schema",
        }
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const getSchemaTool = createTool({
  id: "get_schema",
  description:
    "Fetch detailed information about a specific Papr memory schema by ID. " +
    "Returns full schema definition including node types, relationships, properties, and metadata. " +
    "Use this after list_schemas to get complete details for a specific schema.",
  inputSchema: getSchemasSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.schemas.retrieve(args.schemaId);
      return { success: true, data: response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const updateSchemaTool = createTool({
  id: "update_schema",
  description:
    "Update an existing Papr memory schema. " +
    "Allows modification of schema properties, node types, relationships, and status. " +
    "Updates create a new version while preserving existing data. " +
    "Set status='active' to activate, 'draft' to deactivate, or 'archived' to soft-delete.",
  inputSchema: updateSchemaSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      
      // Build the update params
      const { schemaId, ...updateParams } = args;
      
      const updateBody: SchemaUpdateParams = { body: updateParams };
      const response = await client.schemas.update(schemaId, updateBody);
      
      return { 
        success: true, 
        data: response,
        message: `Schema ${schemaId} updated successfully`
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

// Standard GraphQL introspection query filtered to user-defined types
const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      description
      fields {
        name
        description
        type {
          name
          kind
          ofType { name kind ofType { name kind ofType { name kind } } }
        }
        args {
          name
          description
          type {
            name
            kind
            ofType { name kind ofType { name kind } }
          }
        }
      }
    }
  }
}`;

export interface GraphQLIntrospectionType {
  name: string;
  kind: string;
  description: string | null;
  fields: Array<{
    name: string;
    description: string | null;
    type: GraphQLTypeRef;
    args: Array<{
      name: string;
      description: string | null;
      type: GraphQLTypeRef;
    }>;
  }> | null;
}

export interface GraphQLTypeRef {
  name: string | null;
  kind: string;
  ofType: GraphQLTypeRef | null;
}

function resolveTypeName(typeRef: GraphQLTypeRef): string {
  if (typeRef.name) return typeRef.name;
  if (typeRef.kind === "NON_NULL" && typeRef.ofType)
    return `${resolveTypeName(typeRef.ofType)}!`;
  if (typeRef.kind === "LIST" && typeRef.ofType)
    return `[${resolveTypeName(typeRef.ofType)}]`;
  return "Unknown";
}

const introspectMemoryGraphSchema = z.object({
  typeName: z
    .string()
    .optional()
    .describe(
      "Optional: focus on a specific type name to get detailed field info. Omit to get an overview of all available types.",
    ),
});

const queryMemoryGraphSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The GraphQL query string. Use introspect_memory_graph first to discover available types and fields.",
    ),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional variables for the GraphQL query."),
  operationName: z
    .string()
    .optional()
    .describe("Optional operation name if the query contains multiple operations."),
});

export const introspectMemoryGraphTool = createTool({
  id: "introspect_memory_graph",
  description:
    "Discover the PAPR Memory knowledge graph schema via GraphQL introspection. " +
    "Returns schema read order (WorkspaceContext first, then other active schemas), available types, fields, and relationships. " +
    "Call this BEFORE query_memory_graph to understand the schema structure. Omit typeName for an overview, or provide a specific " +
    "type name for detailed field info.",
  inputSchema: introspectMemoryGraphSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const schemasForRead = await listSchemasForGraphRead(client);
      const readOrderNote = buildGraphReadOrderNote(schemasForRead);

      const response = (await client.graphql.query({
        body: { query: INTROSPECTION_QUERY },
      })) as { data?: { __schema?: { queryType?: { name: string }; mutationType?: { name: string } | null; types?: GraphQLIntrospectionType[] } } };

      const schema = response?.data?.__schema;
      if (!schema?.types) {
        return { success: true, data: { message: "No schema data returned", raw: response } };
      }

      const BUILTIN_PREFIXES = ["__", "String", "Boolean", "Int", "Float", "ID"];
      const userTypes = schema.types.filter(
        (t: GraphQLIntrospectionType) =>
          !BUILTIN_PREFIXES.some((prefix) => t.name.startsWith(prefix)) &&
          t.kind === "OBJECT" &&
          t.fields !== null,
      );

      if (args.typeName) {
        const target = schema.types.find(
          (t: GraphQLIntrospectionType) => t.name.toLowerCase() === args.typeName!.toLowerCase(),
        );
        if (!target) {
          return {
            success: false,
            error: `Type "${args.typeName}" not found. Available types: ${userTypes.map((t: GraphQLIntrospectionType) => t.name).join(", ")}`,
          };
        }
        return {
          success: true,
          data: {
            readOrder: {
              note: readOrderNote,
              schemas: schemasForRead,
            },
            type: target.name,
            kind: target.kind,
            description: target.description,
            fields: target.fields?.map((f) => ({
              name: f.name,
              type: resolveTypeName(f.type),
              description: f.description,
              args: f.args?.length
                ? f.args.map((a) => ({
                    name: a.name,
                    type: resolveTypeName(a.type),
                    description: a.description,
                  }))
                : undefined,
            })),
          },
        };
      }

      const overview = userTypes.map((t: GraphQLIntrospectionType) => ({
        name: t.name,
        description: t.description,
        fieldCount: t.fields?.length ?? 0,
        fields: t.fields?.map((f) => `${f.name}: ${resolveTypeName(f.type)}`),
      }));

      return {
        success: true,
        data: {
          readOrder: {
            note: readOrderNote,
            schemas: schemasForRead,
          },
          queryType: schema.queryType?.name,
          mutationType: schema.mutationType?.name,
          typeCount: userTypes.length,
          types: overview,
        },
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

// Delete memory schema
const deleteMemorySchema = z.object({
  memoryId: z.string().min(1).describe("The memory ID to delete"),
});

const updateMemorySchema = z.object({
  memoryId: z.string().min(1).describe("The memory ID to update (from search results or add response)"),
  content: z
    .string()
    .min(1)
    .optional()
    .describe("Replacement content. Omit to leave the existing content unchanged."),
  metadata: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Metadata fields to update, e.g. { topics: ['fundraising'], hierarchical_structures: 'business/finance' }.",
    ),
});

const addMemoryBatchSchema = z.object({
  memories: z
    .array(
      z.object({
        content: z.string().min(1).describe("Memory content"),
        category: z
          .enum(["preference", "task", "goal", "fact", "context", "skills", "learning"])
          .optional()
          .describe("Memory category. 'preference' is user-only; 'skills'/'learning' are assistant-only."),
        role: z
          .enum(["user", "assistant"])
          .optional()
          .describe("REQUIRED when category is set — the server 422s on category without role."),
        topics: z.array(z.string()).optional().describe("Topic tags for this item"),
      }),
    )
    .min(1)
    .max(50)
    .describe("Memory items to write in one request (max 50)."),
  skipBackgroundProcessing: z
    .boolean()
    .optional()
    .describe("Skip async graph/embedding enrichment for faster writes. Default false."),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Server-side chunk size for processing."),
});

const getBatchStatusSchema = z.object({
  batchId: z.string().min(1).describe("batch_id returned by add_agent_memory_batch"),
});

const submitMemoryFeedbackBatchSchema = z.object({
  items: z
    .array(
      z.object({
        searchId: z.string().min(1).describe("searchId from a prior search_agent_memory response"),
        feedbackType: z
          .enum([
            "thumbs_up",
            "thumbs_down",
            "rating",
            "correction",
            "report",
            "copy_action",
            "save_action",
            "create_document",
            "memory_relevance",
            "answer_quality",
          ])
          .describe("Type of feedback for this search"),
        feedbackScore: z.number().min(1).max(5).optional().describe("1-5 score for rating/memory_relevance"),
        feedbackText: z.string().optional().describe("Explanation, especially for correction/report"),
        citedMemoryIds: z.array(z.string()).optional().describe("Memory IDs that were useful or irrelevant"),
        citedNodeIds: z.array(z.string()).optional().describe("Graph node IDs cited, if any"),
        feedbackSource: z
          .enum(["inline", "post_query", "session_end", "memory_citation", "answer_panel"])
          .optional()
          .describe("Where the feedback originated. Default: inline."),
      }),
    )
    .min(1)
    .max(50)
    .describe("Feedback items to submit in one request (max 50)."),
});

const getMemoryFeedbackSchema = z.object({
  feedbackId: z
    .string()
    .min(1)
    .describe("feedback_id returned by submit_memory_feedback"),
});

const submitMemoryFeedbackSchema = z.object({
  searchId: z
    .string()
    .min(1)
    .describe(
      "searchId from a prior search_agent_memory response. Required to link feedback to that retrieval.",
    ),
  feedbackType: z
    .enum([
      "thumbs_up",
      "thumbs_down",
      "rating",
      "correction",
      "report",
      "copy_action",
      "save_action",
      "create_document",
      "memory_relevance",
      "answer_quality",
    ])
    .describe(
      "Type of feedback. Use thumbs_up/thumbs_down or memory_relevance for retrieval quality; correction when memories were wrong.",
    ),
  feedbackSource: z
    .enum(["inline", "post_query", "session_end", "memory_citation", "answer_panel"])
    .optional()
    .describe("Where feedback originated. Default: inline (agent after search)."),
  citedMemoryIds: z
    .array(z.string())
    .optional()
    .describe("Memory IDs that were useful or irrelevant from the search results."),
  citedNodeIds: z
    .array(z.string())
    .optional()
    .describe("Graph node IDs cited in the feedback, if any."),
  feedbackText: z
    .string()
    .optional()
    .describe("Optional explanation — especially for correction or report feedback."),
  feedbackScore: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .describe("Optional 1-5 score when feedbackType is rating or memory_relevance."),
});

// Delete schema schema
const deleteSchemaSchema = z.object({
  schemaId: z.string().min(1).describe("The schema ID to delete (soft delete - marks as archived)"),
});

// Manual graph generation schemas
const manualNodeSchema = z.object({
  id: z.string().min(1).describe("Unique identifier for this node (must be unique within request)"),
  label: z.string().min(1).describe("Node type label - must match a node type from your registered schema"),
  properties: z.record(z.string(), z.unknown()).describe("Node properties as key-value pairs"),
});

const manualRelationshipSchema = z.object({
  sourceNodeId: z.string().min(1).describe("Source node ID (must match a node 'id' from nodes array)"),
  targetNodeId: z.string().min(1).describe("Target node ID (must match a node 'id' from nodes array)"),
  relationshipType: z.string().min(1).describe("Relationship type - must exist in your registered schema"),
  properties: z.record(z.string(), z.unknown()).optional().describe("Optional relationship properties"),
});

const createEntitiesSchema = z.object({
  content: z.string().min(1).describe("Memory content describing the entities"),
  nodes: z.array(manualNodeSchema).min(1).describe("Exact nodes to create with manual specifications"),
  relationships: z.array(manualRelationshipSchema).optional().describe("Exact relationships to create between nodes"),
  schemaId: z.string().optional().describe("Schema ID that defines the node and relationship types"),
  chatId: z
    .string()
    .optional()
    .describe(
      `Optional chat ID for default Team/Org scope when ACL fields are omitted. Use "${CURRENT_CHAT_SCOPE}" for the active chat.`,
    ),
  ...memoryReadAclToolFields,
});

export const queryMemoryGraphTool = createTool({
  id: "query_memory_graph",
  description:
    "Execute a GraphQL query against the PAPR Memory knowledge graph. " +
    "Queries are automatically filtered by user_id and workspace_id for security. " +
    "Use introspect_memory_graph first to discover available types and fields before writing queries.",
  inputSchema: queryMemoryGraphSchema,
  execute: async (args) => {
    try {
      const normalizedQuery = args.query.trim();
      if (/^\s*mutation\b/i.test(normalizedQuery)) {
        return {
          success: false,
          error: "query_memory_graph is read-only — mutations are not allowed",
        };
      }

      const innerSelection = normalizedQuery
        .replace(/^query\s+\w*\s*/i, "")
        .trim()
        .replace(/^\{/, "")
        .replace(/\}$/, "")
        .trim();
      try {
        assertValidWikiGraphQLSelection(innerSelection);
      } catch (validationError) {
        return {
          success: false,
          error:
            validationError instanceof Error
              ? validationError.message
              : "Invalid GraphQL query",
        };
      }

      const client = await getPaprClient();
      const response = await client.graphql.query({
        body: {
          query: args.query,
          ...(args.variables && { variables: args.variables }),
          ...(args.operationName && { operationName: args.operationName }),
        },
      });
      const typed = response as { data?: unknown; errors?: Array<{ message: string; locations?: unknown; path?: unknown }> };
      if (typed.errors && Array.isArray(typed.errors) && typed.errors.length > 0) {
        return {
          success: false,
          errors: typed.errors.map((e) => ({
            message: e.message,
            locations: e.locations,
            path: e.path,
          })),
          data: typed.data,
        };
      }
      return { success: true, data: typed.data ?? response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const deleteMemoryTool = createTool({
  id: "delete_memory",
  description:
    "Delete a specific memory item by ID. This permanently removes the memory from your knowledge graph.",
  inputSchema: deleteMemorySchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.memory.delete(args.memoryId);
      return {
        success: true,
        data: response,
        message: `Memory ${args.memoryId} deleted successfully`
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const updateMemoryTool = createTool({
  id: "update_memory",
  description:
    "Update an existing memory item in place by ID — corrects a fact WITHOUT creating a duplicate. " +
    "Prefer this over add_agent_memory when a stored value changed (e.g. a revised total, status, or owner); " +
    "re-adding creates near-duplicate memories that degrade retrieval ranking. " +
    "Use delete_memory only when the memory should no longer exist at all.",
  inputSchema: updateMemorySchema,
  execute: async (args) => {
    try {
      if (args.content === undefined && args.metadata === undefined) {
        throw new Error(
          "update_memory requires at least one of `content` or `metadata`.",
        );
      }
      const client = await getPaprClient();
      const response = await client.memory.update(args.memoryId, {
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(args.metadata !== undefined
          ? { metadata: args.metadata as Record<string, unknown> }
          : {}),
      } as Parameters<typeof client.memory.update>[1]);

      return {
        success: true,
        memoryId: args.memoryId,
        data: response,
        message: `Memory ${args.memoryId} updated in place (no duplicate created)`,
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const addAgentMemoryBatchTool = createTool({
  id: "add_agent_memory_batch",
  description:
    "Write multiple memory items in ONE request. Use whenever you are storing 3+ related items " +
    "(entity backfills, a set of tasks, imported records) — far cheaper than looping add_agent_memory. " +
    "Applies the same WorkspaceContext graph schema and ACL scope as add_agent_memory. " +
    "Returns a batch_id; poll get_memory_batch_status to confirm all writes landed.",
  inputSchema: addMemoryBatchSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const { buildPaprMemoryWriteScope } = await import(
        "../../gateway/utils/memoryScopeResolver.js"
      );
      const { spreadMemoryScopeUserIdentity } = await import(
        "../../core/utils/paprMemoryUserIdentity.js"
      );

      // Batch items inherit the chat's default Team/Org scope. For per-user ACLs,
      // use add_agent_memory (which accepts shareWithUserIds / readAcl) instead.
      const resolvedChatId = resolveConversationId(getCurrentChatId() ?? undefined);
      const addPolicy = await buildAgentMemoryAddPolicy({});
      const memoryScope = await buildPaprMemoryWriteScope({
        chatId: resolvedChatId,
        addPolicy,
      });

      const response = await client.memory.addBatch({
        memories: args.memories.map((m) => ({
          content: m.content,
          metadata: {
            ...(m.role ? { role: m.role } : {}),
            ...(m.category ? { category: m.category } : {}),
            ...(m.topics ? { topics: m.topics } : {}),
            ...(resolvedChatId ? { customMetadata: { chatId: resolvedChatId } } : {}),
          },
        })) as Parameters<typeof client.memory.addBatch>[0]["memories"],
        ...(args.skipBackgroundProcessing !== undefined
          ? { skip_background_processing: args.skipBackgroundProcessing }
          : {}),
        ...(args.batchSize !== undefined ? { batch_size: args.batchSize } : {}),
        ...spreadMemoryScopeUserIdentity(memoryScope),
        ...(memoryScope.namespace_id
          ? { namespace_id: memoryScope.namespace_id }
          : {}),
        ...(memoryScope.policy ? { policy: memoryScope.policy } : {}),
      } as Parameters<typeof client.memory.addBatch>[0]);

      const raw = response as unknown as Record<string, unknown>;
      return {
        success: true,
        requested: args.memories.length,
        batchId: (raw.batch_id as string | undefined) ?? null,
        data: response,
        _statusReminder:
          "Writes are processed asynchronously. If a later search cannot find these items, " +
          "call get_memory_batch_status with the returned batchId before assuming the write failed.",
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const getMemoryBatchStatusTool = createTool({
  id: "get_memory_batch_status",
  description:
    "Check processing status of an add_agent_memory_batch write. Memory writes are asynchronous " +
    "(embedding + graph extraction + Parse persistence), so use this to distinguish a SLOW write " +
    "from a FAILED one before retrying or reporting an error.",
  inputSchema: getBatchStatusSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.memory.retrieveBatchStatus(args.batchId);
      return { success: true, batchId: args.batchId, data: response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const submitMemoryFeedbackBatchTool = createTool({
  id: "submit_memory_feedback_batch",
  description:
    "Submit retrieval feedback for MULTIPLE searches in one request. Use at the end of a session " +
    "when several searches are being rated together, instead of calling submit_memory_feedback repeatedly.",
  inputSchema: submitMemoryFeedbackBatchSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const { paprUserScope } = await import("../../gateway/utils/paprUserId.js");
      const scope = paprUserScope();

      const response = await client.feedback.submitBatch({
        feedback_items: args.items.map((item) => ({
          search_id: item.searchId,
          ...scope,
          feedbackData: {
            feedbackSource: item.feedbackSource ?? "inline",
            feedbackType: item.feedbackType,
            ...(item.citedMemoryIds ? { citedMemoryIds: item.citedMemoryIds } : {}),
            ...(item.citedNodeIds ? { citedNodeIds: item.citedNodeIds } : {}),
            ...(item.feedbackText ? { feedbackText: item.feedbackText } : {}),
            ...(item.feedbackScore !== undefined
              ? { feedbackScore: item.feedbackScore }
              : {}),
          },
        })) as Parameters<typeof client.feedback.submitBatch>[0]["feedback_items"],
      });

      return { success: true, submitted: args.items.length, data: response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const getMemoryFeedbackTool = createTool({
  id: "get_memory_feedback",
  description:
    "Fetch a previously submitted feedback record by feedback_id. Use to verify feedback was " +
    "persisted server-side, or to inspect what was recorded for a given search.",
  inputSchema: getMemoryFeedbackSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.feedback.getByID(args.feedbackId);
      return { success: true, feedbackId: args.feedbackId, data: response };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const submitMemoryFeedbackTool = createTool({
  id: "submit_memory_feedback",
  description:
    "Submit retrieval-quality feedback to Papr Memory after evaluating search_agent_memory results. " +
    "Use the searchId from that search response. Only submit when results were clearly helpful or clearly irrelevant — not on every search. " +
    "For wrong memory content, prefer delete_memory or add_agent_memory instead of correction feedback alone.",
  inputSchema: submitMemoryFeedbackSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const { paprUserScope } = await import("../../gateway/utils/paprUserId.js");

      const feedbackData: FeedbackSubmitParams.FeedbackData = {
        feedbackSource: args.feedbackSource ?? "inline",
        feedbackType: args.feedbackType,
        ...(args.citedMemoryIds ? { citedMemoryIds: args.citedMemoryIds } : {}),
        ...(args.citedNodeIds ? { citedNodeIds: args.citedNodeIds } : {}),
        ...(args.feedbackText ? { feedbackText: args.feedbackText } : {}),
        ...(args.feedbackScore !== undefined ? { feedbackScore: args.feedbackScore } : {}),
      };

      const response = await client.feedback.submit({
        search_id: args.searchId,
        ...paprUserScope(),
        feedbackData,
      });

      return {
        success: true,
        feedbackId: response.feedback_id ?? null,
        message: response.message ?? "Feedback submitted",
        data: response,
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const deleteSchemaTool = createTool({
  id: "delete_schema",
  description:
    "Soft-delete a schema by marking it as archived. The schema data is preserved but marked inactive. " +
    "This does not permanently remove the schema - use update_schema with status='active' to restore it.",
  inputSchema: deleteSchemaSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.schemas.delete(args.schemaId);
      return { 
        success: true, 
        data: response,
        message: `Schema ${args.schemaId} archived successfully`
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const createEntitiesAndRelationshipsTool = createTool({
  id: "create_entities",
  description:
    "Create entities (nodes) and relationships in the knowledge graph with exact specifications. " +
    "Use this for structured data imports, API integrations, or when you need complete control over graph structure. " +
    "Nodes and relationships must conform to types defined in your registered schema. " +
    "Supports the same read ACL options as add_agent_memory (readAcl, shareWithUserIds, shareWithTeam, shareWithOrganization). " +
    "Call list_namespace_users before sharing with specific users.",
  inputSchema: createEntitiesSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const {
        buildPaprMemoryWriteScope,
        resolveExplicitReadAclFromToolArgs,
        withMemoryScopeMetadata,
      } = await import("../../gateway/utils/memoryScopeResolver.js");
      const { spreadMemoryScopeUserIdentity } = await import(
        "../../core/utils/paprMemoryUserIdentity.js"
      );

      const resolvedChatId = resolveConversationId(
        args.chatId ?? getCurrentChatId() ?? undefined,
      );
      
      // Build manual graph generation structure
      const manualGeneration = {
        nodes: args.nodes.map(node => ({
          id: node.id,
          type: node.label, // SDK uses 'type' for node label
          properties: node.properties,
        })),
        ...(args.relationships && args.relationships.length > 0 ? {
          relationships: args.relationships.map(rel => ({
            source: rel.sourceNodeId, // SDK uses 'source' not 'source_node_id'
            target: rel.targetNodeId, // SDK uses 'target' not 'target_node_id'
            type: rel.relationshipType, // SDK uses 'type' not 'relationship_type'
            ...(rel.properties && { properties: rel.properties }),
          }))
        } : {}),
      };
      
      const manualPolicy = buildAddPolicy({
        graphMode: "manual",
        graphSchemaId: args.schemaId,
        manualNodes: manualGeneration.nodes,
        manualRelationships: manualGeneration.relationships,
      });

      const memoryScope = await buildPaprMemoryWriteScope({
        chatId: resolvedChatId,
        addPolicy: manualPolicy,
        explicitReadAcl: resolveExplicitReadAclFromToolArgs(args),
      });

      const response = await client.memory.add({
        content: args.content,
        ...spreadMemoryScopeUserIdentity(memoryScope),
        ...(memoryScope.namespace_id
          ? { namespace_id: memoryScope.namespace_id }
          : {}),
        ...(memoryScope.policy ? { policy: memoryScope.policy } : {}),
        metadata: withMemoryScopeMetadata({}, memoryScope),
      });
      
      return { 
        success: true, 
        data: response,
        message: `Created ${args.nodes.length} entities${args.relationships ? ` and ${args.relationships.length} relationships` : ""}`,
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

// List built-in signal domains for transform_embedding and vector policy
export const listSignalDomainsTool = createTool({
  id: "list_signal_domains",
  description:
    "List available signal domains for Papr Memory vector search and transform embedding. " +
    "Use domain IDs with signalDomain in add_agent_memory and vectorPolicy.domainId in search_agent_memory. " +
    "Returns built-in domains (e.g. 'general', 'code', 'cosqa', 'scifact') and their signal band counts. " +
    "⚠️ NOTE: These are different from knowledge graph schemas (use list_schemas for those).",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const client = await getPaprClient();

      const response = await client.graph.domains.list();

      const domains = response.domains.map((domain) => ({
        id: domain.domain_id,
        name: domain.name,
        signalBandCount: domain.signals.length,
        description:
          domain.description ||
          `${domain.signals.length} signal bands for ${domain.name}`,
        builtin: domain.builtin ?? false,
      }));
      
      return {
        success: true,
        data: {
          count: domains.length,
          domains,
          note:
            "Use domain id with signalDomain (add) or vectorPolicy.domainId (search). " +
            "category='code' search defaults to domain 'code' automatically.",
        }
      };
    } catch (error) {
      handlePaprToolError(error);
    }
  },
});

export const paprMemoryTools = [
  addAgentMemoryTool,
  addAgentMemoryBatchTool,
  getMemoryBatchStatusTool,
  updateMemoryTool,
  listNamespaceUsersTool,
  searchAgentMemoryTool,
  submitMemoryFeedbackTool,
  submitMemoryFeedbackBatchTool,
  getMemoryFeedbackTool,
  registerSchemaTool,
  updateSchemaTool,
  listSchemasTool,
  getSchemaTool,
  listSignalDomainsTool,
  introspectMemoryGraphTool,
  queryMemoryGraphTool,
  deleteMemoryTool,
  deleteSchemaTool,
  createEntitiesAndRelationshipsTool,
];

// Re-export SDK types for use in other files
export type { MemoryObject };
