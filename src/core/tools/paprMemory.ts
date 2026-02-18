import Papr from "@papr/memory";
import type { Memory } from "@papr/memory/resources/memory.js";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const addMemorySchema = z.object({
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
});

const searchMemorySchema = z.object({
  query: z.string().min(1).describe(
    "2-3 sentence query for best results. Include specific details, context, and time frame."
  ),
  externalUserId: z.string().optional(),
  maxMemories: z.number().int().min(1).max(30).optional().describe(
    "Number of memories to return. Default 20. Use 15-20 for comprehensive results."
  ),
});

const registerSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
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
  description: "Store a structured memory item in PAPR memory",
  inputSchema: addMemorySchema,
  execute: async (args) => {
    const client = await getPaprClient();

    // Build customMetadata for fields not in the MemoryMetadata spec
    const customMetadata: Record<string, string> = {};
    if (args.sourceAgentId) customMetadata.sourceAgentId = args.sourceAgentId;
    if (args.sourceAgentName) customMetadata.sourceAgentName = args.sourceAgentName;
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
  },
});

export const searchAgentMemoryTool = createTool({
  id: "search_agent_memory",
  description: "Search relevant memories from PAPR memory. Use 2-3 sentence queries for best results.",
  inputSchema: searchMemorySchema,
  execute: async (args) => {
    const client = await getPaprClient();
    const response = await client.memory.search({
      query: args.query,
      external_user_id: args.externalUserId,
      max_memories: args.maxMemories ?? 20,
      max_nodes: 15,
      enable_agentic_graph: true,
      response_format: "toon", // 30-60% token reduction for LLM contexts
    });
    return { success: true, data: response };
  },
});

export const registerSchemaTool = createTool({
  id: "register_schema",
  description: "Register a PAPR memory schema for custom entity types",
  inputSchema: registerSchemaSchema,
  execute: async (args) => {
    const client = await getPaprClient();
    const response = await client.schemas.create({
      name: args.name,
      description: args.description,
    });
    return { success: true, data: response };
  },
});

export const paprMemoryTools = [
  addAgentMemoryTool,
  searchAgentMemoryTool,
  registerSchemaTool,
];

// Re-export SDK types for use in other files
export type { Memory };
