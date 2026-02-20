import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const createSubAgentSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "google"]).optional(),
  model: z.string().min(1).optional(),
  allowedToolIds: z.array(z.string().min(1)).optional(),
  assignedSkills: z.array(z.string().min(1)).optional(),
  outputMode: z.enum(["natural", "structured"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  memoryPolicy: z.enum(["none", "summary", "full"]).optional(),
});

const deleteSubAgentSchema = z.object({
  agentId: z.string().min(1),
});

const delegateTaskSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
  useAgentId: z.string().min(1).optional(),
  reportChatId: z.string().min(1).optional(),
  background: z.boolean().optional(),
  outputMode: z.enum(["natural", "structured"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  memoryPolicy: z.enum(["none", "summary", "full"]).optional(),
});

const getDelegationRunSchema = z.object({
  runId: z.string().min(1),
});

const listDelegationRunsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

type CreateSubAgentArgs = z.infer<typeof createSubAgentSchema>;
type DeleteSubAgentArgs = z.infer<typeof deleteSubAgentSchema>;
type DelegateTaskArgs = z.infer<typeof delegateTaskSchema>;
type GetDelegationRunArgs = z.infer<typeof getDelegationRunSchema>;
type ListDelegationRunsArgs = z.infer<typeof listDelegationRunsSchema>;

export const listSubAgentsTool = createTool({
  id: "list_sub_agents",
  description: "List available sub-agent profiles and their capabilities",
  // OpenAI function tools require parameters schema to always be an object.
  inputSchema: z.object({}),
  execute: async () => {
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const agents = await service.listAgents();
    return { success: true, data: { agents } };
  },
});

export const createSubAgentTool = createTool({
  id: "create_sub_agent",
  description:
    "Create or update a persistent sub-agent profile. If allowedToolIds not specified, defaults to ['bash', 'read_file', 'write_file'] for basic file and database access.",
  inputSchema: createSubAgentSchema,
  execute: async (input) => {
    const args = (input as { context?: CreateSubAgentArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();

    // Apply default tools if not specified
    const argsWithDefaults = {
      ...args,
      allowedToolIds: args.allowedToolIds || [
        "bash",
        "read_file",
        "write_file",
      ],
    };

    const agent = await service.createOrUpdateAgent(argsWithDefaults);
    return { success: true, data: agent };
  },
});

export const deleteSubAgentTool = createTool({
  id: "delete_sub_agent",
  description: "Delete a persistent sub-agent profile",
  inputSchema: deleteSubAgentSchema,
  execute: async (input) => {
    const args = (input as { context?: DeleteSubAgentArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const deleted = await service.deleteAgent(args.agentId);
    return { success: true, data: { agentId: args.agentId, deleted } };
  },
});

export const delegateTaskTool = createTool({
  id: "delegate_task",
  description:
    "Delegate a task to a sub-agent, optionally in background with chat report-back",
  inputSchema: delegateTaskSchema,
  execute: async (input) => {
    const args = (input as { context?: DelegateTaskArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const run = await service.delegateTask(args);
    return { success: true, data: run };
  },
});

export const getDelegationRunTool = createTool({
  id: "get_delegation_run",
  description: "Get status/details for one delegated sub-agent run",
  inputSchema: getDelegationRunSchema,
  execute: async (input) => {
    const args = (input as { context?: GetDelegationRunArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const run = await service.getRun(args.runId);
    if (!run) {
      throw new Error(`Delegation run not found: ${args.runId}`);
    }
    return { success: true, data: run };
  },
});

export const listDelegationRunsTool = createTool({
  id: "list_delegation_runs",
  description: "List recent delegated sub-agent runs",
  inputSchema: listDelegationRunsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: ListDelegationRunsArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const runs = await service.listRuns(args.limit ?? 50);
    return { success: true, data: { runs } };
  },
});

export const delegationTools = [
  listSubAgentsTool,
  createSubAgentTool,
  deleteSubAgentTool,
  delegateTaskTool,
  getDelegationRunTool,
  listDelegationRunsTool,
];
