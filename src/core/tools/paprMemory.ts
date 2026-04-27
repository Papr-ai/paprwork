import Papr from "@papr/memory";
import type { Memory } from "@papr/memory/resources/memory.js";
import type { SchemaListResponse, UserGraphSchemaOutput as Schema, SchemaCreateParams } from "@papr/memory/resources/schemas.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const addMemorySchema = z
  .object({
    content: z.string().min(1),
    // externalUserId removed - API key scopes to user automatically
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
    // Holographic neural transforms
    enableHolographic: z.boolean().optional().describe("Enable holographic neural transforms for enhanced semantic search"),
    frequencySchemaId: z.string().optional().describe("Frequency schema for holographic embedding (e.g. 'cosqa', 'scifact'). Required when enableHolographic=true"),
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
  )
  .refine(
    (data) => {
      // Require frequency_schema_id when enable_holographic is true
      if (data.enableHolographic && !data.frequencySchemaId) {
        return false;
      }
      return true;
    },
    {
      message: 'When enableHolographic is true, frequencySchemaId is required',
      path: ["frequencySchemaId"],
    },
  );

const searchMemorySchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "2-3 sentence query for best results. Include specific details, context, and time frame.",
    ),
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
  // Holographic neural embedding configuration
  holographicConfig: z.object({
    enabled: z.boolean().optional().describe("Enable holographic neural transforms"),
    frequencySchemaId: z.string().optional().describe("Frequency schema for holographic scoring (e.g. 'cosqa', 'scifact'). Call GET /v1/frequencies for available schemas"),
    searchMode: z.enum(['disabled', 'integrated', 'post_search']).optional().describe("How to apply holographic: 'integrated' searches transformed embeddings, 'post_search' fetches then reranks with H-COND"),
    scoringMethod: z.string().optional().describe("Scoring method (160+ options: 'egr_rerank', 'caesar8', etc.). If null, uses schema's default"),
    includeFrequencyScores: z.boolean().optional().describe("Return per-frequency score breakdown showing how well query matched on each dimension (e.g. programming_domain: 0.95). Useful for understanding WHY results ranked high/low"),
    frequencyFilters: z.record(z.string(), z.number()).optional().describe("Filter results by minimum alignment on frequency dimensions. Keys are field names (e.g. 'programming_domain'), values are minimum scores (0.0-1.0). Example: {'programming_domain': 0.8}"),
    hcondBoostFactor: z.number().min(0).max(0.5).optional().describe("Maximum boost for high phase alignment (0.0-0.5)"),
    hcondBoostThreshold: z.number().min(0).max(1.0).optional().describe("Phase alignment threshold to apply boost (0.0-1.0)"),
    hcondPenaltyFactor: z.number().min(0).max(0.5).optional().describe("Maximum penalty for low phase alignment (0.0-0.5)"),
  }).optional().describe("Configuration for holographic neural embedding transforms and frequency-based scoring"),
});

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
        // external_user_id omitted - API key scopes to user automatically
        enable_holographic: args.enableHolographic,
        frequency_schema_id: args.frequencySchemaId,
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

      // Build holographic_config if provided (convert camelCase to snake_case for SDK)
      const holographicConfig = args.holographicConfig ? {
        enabled: args.holographicConfig.enabled,
        frequency_schema_id: args.holographicConfig.frequencySchemaId,
        search_mode: args.holographicConfig.searchMode,
        scoring_method: args.holographicConfig.scoringMethod,
        include_frequency_scores: args.holographicConfig.includeFrequencyScores,
        frequency_filters: args.holographicConfig.frequencyFilters,
        hcond_boost_factor: args.holographicConfig.hcondBoostFactor,
        hcond_boost_threshold: args.holographicConfig.hcondBoostThreshold,
        hcond_penalty_factor: args.holographicConfig.hcondPenaltyFactor,
      } : undefined;

      const response = await client.memory.search({
        query: args.query,
        // external_user_id omitted - API key scopes to user automatically
        max_memories: args.maxMemories ?? 20,
        max_nodes: 15,
        enable_agentic_graph: true,
        rank_results: true,
        response_format: "toon",
        ...(holographicConfig && { holographic_config: holographicConfig }),
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
    "List KNOWLEDGE GRAPH schemas (user-created entity/relationship schemas). Returns schemas with node types and relationships. " +
    "Use get_schema to fetch full details (node types, relationships, properties) for a specific schema. " +
    "⚠️ NOTE: For HOLOGRAPHIC frequency schemas, use list_frequency_schemas instead.",
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
      
      const response = await client.schemas.update(schemaId, { body: updateParams } as any);
      
      return { 
        success: true, 
        data: response,
        message: `Schema ${schemaId} updated successfully`
      };
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

// Delete memory schema
const deleteMemorySchema = z.object({
  memoryId: z.string().min(1).describe("The memory ID to delete"),
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

export const createEntitiesAndRelationshipsTool = createTool({
  id: "create_entities",
  description:
    "Create entities (nodes) and relationships in the knowledge graph with exact specifications. " +
    "Use this for structured data imports, API integrations, or when you need complete control over graph structure. " +
    "Nodes and relationships must conform to types defined in your registered schema.",
  inputSchema: createEntitiesSchema,
  execute: async (args) => {
    try {
      const client = await getPaprClient();
      
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
      
      const response = await client.memory.add({
        content: args.content,
        memory_policy: {
          mode: 'manual',
          nodes: manualGeneration.nodes,
          relationships: manualGeneration.relationships,
          ...(args.schemaId && { schema_id: args.schemaId }),
        },
      });
      
      return { 
        success: true, 
        data: response,
        message: `Created ${args.nodes.length} entities${args.relationships ? ` and ${args.relationships.length} relationships` : ''}`
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

// List frequency schemas (for holographic neural transforms)
export const listFrequencySchemasTool = createTool({
  id: "list_frequency_schemas",
  description:
    "List available FREQUENCY SCHEMAS for holographic neural transforms. " +
    "These are pre-built by Papr and used with enableHolographic parameter in add_agent_memory and holographicConfig in search_agent_memory. " +
    "Returns schema IDs (e.g., 'general', 'cosqa', 'scifact') and their frequency counts. " +
    "⚠️ NOTE: These are different from knowledge graph schemas (use list_schemas for those).",
  inputSchema: z.object({}), // No parameters needed
  execute: async () => {
    try {
      const client = await getPaprClient();
      
      // Fetch frequency schemas from /v1/frequencies endpoint
      // Note: SDK doesn't have a direct method, so we use the underlying fetch
      const response = await fetch('https://api.papr.ai/v1/frequencies', {
        headers: {
          'X-API-Key': client['xAPIKey'], // Access internal API key
        },
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch frequency schemas: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json() as { data?: Array<{ id: string; name: string; frequency_count: number; description?: string }> };
      
      // Format response for agent readability
      const schemas = data.data?.map((schema) => ({
        id: schema.id,
        name: schema.name,
        frequencyCount: schema.frequency_count,
        description: schema.description || `${schema.frequency_count} frequency dimensions for ${schema.name}`
      })) ?? [];
      
      return {
        success: true,
        data: {
          count: schemas.length,
          schemas: schemas,
          note: "Use these IDs with frequencySchemaId parameter in add_agent_memory or holographicConfig in search_agent_memory"
        }
      };
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

export const paprMemoryTools = [
  addAgentMemoryTool,
  searchAgentMemoryTool,
  registerSchemaTool,
  updateSchemaTool,
  listSchemasTool,
  getSchemaTool,
  listFrequencySchemasTool, // NEW: List frequency schemas
  introspectMemoryGraphTool,
  queryMemoryGraphTool,
  deleteMemoryTool,
  deleteSchemaTool,
  createEntitiesAndRelationshipsTool,
];

// Re-export SDK types for use in other files
export type { Memory };
