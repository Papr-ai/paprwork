import Papr from "@papr/memory";
import type { Memory } from "@papr/memory/resources/memory.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const addMemorySchema = z
  .object({
    content: z.string().min(1),
    externalUserId: z.string().optional(),
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

const searchMemorySchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "2-3 sentence query for best results. Include specific details, context, and time frame.",
    ),
  externalUserId: z.string().optional(),
  maxMemories: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Number of memories to return. Default 20. Use 15-20 for comprehensive results.",
    ),
  category: z
    .enum(["agent_memory", "code"])
    .optional()
    .describe(
      "Filter by memory category. 'agent_memory' for conversation memories, 'code' for code files and projects.",
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
});

const registerSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const listSchemasSchema = z.object({
  statusFilter: z
    .enum(["draft", "active", "deprecated", "archived"])
    .optional()
    .describe("Filter schemas by status"),
  workspaceId: z.string().optional().describe("Filter schemas by workspace ID"),
});

async function getPaprClient(): Promise<Papr> {
  const { getApiKey } = await import("../../gateway/utils/keyResolver.js");
  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    throw new Error("PAPR_API_KEY is not configured");
  }
  return new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 30000,
  });
}

export const addAgentMemoryTool = createTool({
  id: "add_agent_memory",
  description:
    "Store a structured memory item in PAPR memory. IMPORTANT: When using category='context', you MUST provide role ('user' or 'assistant').",
  inputSchema: addMemorySchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();

      // Build customMetadata for fields not in the MemoryMetadata spec
      const customMetadata: Record<string, string> = {};
      if (args.sourceAgentId) customMetadata.sourceAgentId = args.sourceAgentId;
      if (args.sourceAgentName)
        customMetadata.sourceAgentName = args.sourceAgentName;
      if (args.runId) customMetadata.runId = args.runId;
      if (args.jobId) customMetadata.jobId = args.jobId;
      if (args.chatId) customMetadata.chatId = args.chatId;
      if (args.workspaceId) customMetadata.workspaceId = args.workspaceId;

      const response = await client.memory.add({
        content: args.content,
        external_user_id: args.externalUserId,
        metadata: {
          role: args.role,
          category: args.category,
          ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
        },
      });
      return { success: true, data: response };
    } catch (error) {
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "Papr Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid Papr API key. Please check your Settings and ensure your API key is correct."
        );
      }
      throw error;
    }
  },
});

export const searchAgentMemoryTool = createTool({
  id: "search_agent_memory",
  description:
    "Search relevant memories from PAPR memory. Use 2-3 sentence queries for best results. " +
    "For code search: set category='code' and optionally filter by projectId (appId/jobId), " +
    "projectType ('mini_app'/'job'), language, or fileName to narrow results to a specific app or job.",
  inputSchema: searchMemorySchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();

      // Build customMetadata filters from code search params
      const customMetadata: Record<string, string | number | boolean> = {};
      if (args.projectId) customMetadata.project_id = args.projectId;
      if (args.projectType) customMetadata.project_type = args.projectType;
      if (args.language) customMetadata.language = args.language;
      if (args.fileName) customMetadata.file_name = args.fileName;
      if (args.category === "code") customMetadata.source = "code_indexer";

      const hasMetadataFilters = Object.keys(customMetadata).length > 0;

      const response = await client.memory.search({
        query: args.query,
        external_user_id: args.externalUserId,
        max_memories: args.maxMemories ?? 20,
        max_nodes: 15,
        enable_agentic_graph: true,
        rank_results: true,
        response_format: "toon",
        // Pass filters via SDK's metadata.customMetadata + category
        ...(args.category || hasMetadataFilters
          ? {
              metadata: {
                ...(args.category === "code"
                  ? { category: "learning" as const }
                  : {}),
                ...(hasMetadataFilters ? { customMetadata } : {}),
              },
            }
          : {}),
      });
      return { success: true, data: response };
    } catch (error) {
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "Papr Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid Papr API key. Please check your Settings and ensure your API key is correct."
        );
      }
      throw error;
    }
  },
});

export const registerSchemaTool = createTool({
  id: "register_schema",
  description:
    "Register a Papr memory schema for custom entity types. Creates node types and relationships for structured knowledge graphs.",
  inputSchema: registerSchemaSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.schemas.create({
        name: args.name,
        description: args.description,
      });
      return { success: true, data: response };
    } catch (error) {
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "Papr Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid Papr API key. Please check your Settings and ensure your API key is correct."
        );
      }
      throw error;
    }
  },
});

export const listSchemasTool = createTool({
  id: "list_schemas",
  description:
    "List all memory schemas accessible to the user. Returns schema definitions with node types, relationships, and metadata.",
  inputSchema: listSchemasSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      const response = await client.schemas.list({
        status_filter: args.statusFilter,
        workspace_id: args.workspaceId,
      });
      return { success: true, data: response };
    } catch (error) {
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features."
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid PAPR API key. Please check your Settings and ensure your API key is correct."
        );
      }
      throw error;
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
    "Returns available types, fields, and relationships. Call this BEFORE query_memory_graph " +
    "to understand the schema structure. Omit typeName for an overview, or provide a specific " +
    "type name for detailed field info.",
  inputSchema: introspectMemoryGraphSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
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
          queryType: schema.queryType?.name,
          mutationType: schema.mutationType?.name,
          typeCount: userTypes.length,
          types: overview,
        },
      };
    } catch (error) {
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features.",
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid PAPR API key. Please check your Settings and ensure your API key is correct.",
        );
      }
      throw error;
    }
  },
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
      if (error instanceof Papr.RateLimitError || error instanceof Papr.PermissionDeniedError) {
        throw new Error(
          "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings to continue using memory features.",
        );
      } else if (error instanceof Papr.AuthenticationError) {
        throw new Error(
          "Invalid PAPR API key. Please check your Settings and ensure your API key is correct.",
        );
      }
      throw error;
    }
  },
});

export const paprMemoryTools = [
  addAgentMemoryTool,
  searchAgentMemoryTool,
  registerSchemaTool,
  listSchemasTool,
  introspectMemoryGraphTool,
  queryMemoryGraphTool,
];

// Re-export SDK types for use in other files
export type { Memory };
