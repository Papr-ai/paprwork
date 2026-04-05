import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Valid model IDs for sub-agents — prevents agent from typing name/id in model field */
const SUBAGENT_MODEL_IDS = [
  "gpt-5.4-mini",
  "gpt-5.4-low",
  "gpt-5.4",
  "gpt-5.4-high",
  "gpt-5.3-codex",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-6",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
] as const;

const SUBAGENT_ICON_NAMES = ["robot", "search", "code", "pen", "chart"] as const;

const createSubAgentSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  provider: z
    .enum(["anthropic", "openai", "openai-codex", "google"])
    .optional(),
  model: z.enum(SUBAGENT_MODEL_IDS).optional(),
  allowedToolIds: z.array(z.string().min(1)).optional(),
  assignedSkills: z.array(z.string().min(1)).optional(),
  outputMode: z.enum(["natural", "structured"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  memoryPolicy: z.enum(["none", "summary", "full"]).optional(),
  icon: z
    .enum(SUBAGENT_ICON_NAMES)
    .optional()
    .describe(
      "Icon for sidebar/mini-chat: robot, search, code, pen, or chart (sidebar-style SVG, not emoji)",
    ),
});

const deleteSubAgentSchema = z.object({
  agentId: z.string().min(1),
});

const delegateTaskSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
  useAgentId: z.string().min(1).optional(),
  reportChatId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Chat ID to deliver result to. Omit for logs-only. When delegating work the user should see, pass this or leave empty to auto-use current chat.",
    ),
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
    "Create or update a persistent sub-agent profile. Specify icon (robot, search, code, pen, chart) for sidebar/mini-chat. If allowedToolIds not specified, defaults to ['bash', 'read_file', 'write_file'].",
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
    const { getCurrentChatId } = await import("./context.js");
    const service = getSubAgentService();
    
    // CRITICAL: Capture chatId from tool context at delegation creation time
    // This ensures the delegation reports to the chat that initiated it,
    // not whatever chat happens to be active when the job completes
    const contextChatId = getCurrentChatId();
    
    // Determine reportChatId: use explicit arg, or context chat (if not a job), or undefined
    const reportChatId =
      args.reportChatId?.trim() ||
      (contextChatId && !contextChatId.startsWith("job:") ? contextChatId : undefined);
    
    // ALWAYS run in background so tool returns immediately with job ID (enables real-time UI updates)
    const run = await service.delegateTask({ ...args, reportChatId, background: true });
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

// ========== Multi-Turn Sub-Agent Communication Tools ==========

const requestAgentInputSchema = z.object({
  question: z.string().min(1).describe("Question for the main agent"),
  urgency: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Priority level"),
  delegationId: z
    .string()
    .min(1)
    .optional()
    .describe("Delegation/job ID (injected by executor)"),
});

const respondToSubAgentSchema = z.object({
  delegationId: z
    .string()
    .min(1)
    .describe("ID of the delegation to respond to"),
  message: z.string().min(1).describe("Response message"),
});

const completeDelegationSchema = z.object({
  result: z.string().min(1).describe("Final result to return to main agent"),
  summary: z.string().optional().describe("Optional brief summary"),
});

type RequestAgentInputArgs = z.infer<typeof requestAgentInputSchema>;
type RespondToSubAgentArgs = z.infer<typeof respondToSubAgentSchema>;
type CompleteDelegationArgs = z.infer<typeof completeDelegationSchema>;

/**
 * Tool for sub-agents to ask questions to the main agent
 * When delegationId is provided (injected by executor): blocks until main agent responds, then returns the response.
 * When delegationId is absent: fire-and-forget (legacy).
 */
export const requestAgentInputTool = createTool({
  id: "request_agent_input",
  description:
    "Ask the main agent for clarification or guidance. Use when you need additional context to complete your task. The main agent will see your question in the mini-chat and respond. You will receive their response and can continue.",
  inputSchema: requestAgentInputSchema,
  execute: async (input) => {
    const args =
      (input as { context?: RequestAgentInputArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();

    if (args.delegationId) {
      // Block until main agent responds; return response so sub-agent can continue
      try {
        const response = await service.sendQuestionAndWaitForResponse(
          args.delegationId,
          args.question,
          args.urgency || "medium",
        );
        return {
          success: true,
          data: {
            message: `Main agent responded: ${response}`,
            question: args.question,
            response,
            status: "resumed",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          data: {
            message: `Failed to get response: ${msg}`,
            question: args.question,
            status: "timeout",
          },
        };
      }
    }

    // Fallback: fire-and-forget without delegationId
    await service.sendQuestionToMainAgent(
      args.question,
      args.urgency || "medium",
      args.delegationId,
    );
    return {
      success: true,
      data: {
        message: "Question sent to main agent. Waiting for response...",
        question: args.question,
        status: "waiting",
      },
    };
  },
});

/**
 * Tool for main agent to respond to sub-agent questions
 * Resumes sub-agent execution with the provided context
 */
export const respondToSubAgentTool = createTool({
  id: "respond_to_sub_agent",
  description:
    "Respond to a sub-agent's question. Answer yourself using your knowledge and context; only ask the user if you truly cannot answer (e.g. missing credentials, subjective preference, or info only they have). The sub-agent receives your message and continues.",
  inputSchema: respondToSubAgentSchema,
  execute: async (input) => {
    const args =
      (input as { context?: RespondToSubAgentArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();

    // Send response to sub-agent chat
    await service.respondToSubAgent(args.delegationId, args.message);

    return {
      success: true,
      data: {
        delegationId: args.delegationId,
        message: "Response sent to sub-agent",
        status: "resumed",
      },
    };
  },
});

/**
 * Tool for sub-agents to mark delegation as complete
 * Closes the sub-agent chat session and returns final result
 */
export const completeDelegationTool = createTool({
  id: "complete_delegation",
  description:
    "Mark your delegation task as complete and return the final result. Use this when you have finished the assigned task and have a result to deliver.",
  inputSchema: completeDelegationSchema,
  execute: async (input) => {
    const args =
      (input as { context?: CompleteDelegationArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();

    // Mark delegation as completed and close session
    await service.completeDelegation(args.result, args.summary);

    return {
      success: true,
      data: {
        result: args.result,
        summary: args.summary,
        status: "completed",
      },
    };
  },
});

export const delegationTools = [
  listSubAgentsTool,
  createSubAgentTool,
  deleteSubAgentTool,
  delegateTaskTool,
  getDelegationRunTool,
  listDelegationRunsTool,
  requestAgentInputTool,
  respondToSubAgentTool,
  completeDelegationTool,
];
