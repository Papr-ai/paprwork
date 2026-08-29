import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  buildDelegateTaskValidationError,
  DELEGATE_TASK_EXAMPLE,
  formatDelegateTaskZodError,
  PRODUCT_ARCHITECT_DELEGATE_ID,
  unwrapDelegateTaskRawInput,
} from "./delegateTaskValidation.js";

/** Valid model IDs for sub-agents — prevents agent from typing name/id in model field */
const SUBAGENT_MODEL_IDS = [
  "gpt-5-6-luna",
  "gpt-5-6-terra",
  "gpt-5-6-sol-low",
  "gpt-5-6-sol",
  "gpt-5-6-sol-high",
  "gpt-5.4-mini",
  "gpt-5.5-low",
  "gpt-5.5",
  "gpt-5.5-high",
  "gpt-5.3-codex",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-5",
  "claude-opus-4-6",
  "claude-opus-5",
  "claude-fable-5",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
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
  force: z
    .boolean()
    .optional()
    .describe(
      "Set true only after removing app agent chat / job references. Default blocks delete when apps or jobs still reference this profile.",
    ),
});

const delegateTaskSchema = z
  .object({
    useAgentId: z
      .string()
      .min(1)
      .describe(
        'REQUIRED first field. Exact sub-agent id from list_sub_agents() — for every new mini-app use "product-architect". Never agentId, subAgentId, or display name.',
      ),
    task: z
      .string()
      .min(1)
      .describe(
        "What the sub-agent should produce. For product-architect: Product brief + Paprwork architecture for: [one-sentence user goal].",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Optional constraints: user requirements, existing apps/jobs, data sources, brand notes.",
      ),
    reportChatId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Chat ID to deliver result to. Omit to auto-use current chat.",
      ),
    background: z.boolean().optional(),
    outputMode: z.enum(["natural", "structured"]).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    memoryPolicy: z.enum(["none", "summary", "full"]).optional(),
  })
  .strict();

const getDelegationRunSchema = z.object({
  runId: z.string().min(1),
});

const listDelegationRunsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

type CreateSubAgentArgs = z.infer<typeof createSubAgentSchema>;
type DeleteSubAgentArgs = z.infer<typeof deleteSubAgentSchema>;
type GetDelegationRunArgs = z.infer<typeof getDelegationRunSchema>;
type ListDelegationRunsArgs = z.infer<typeof listDelegationRunsSchema>;

export const listSubAgentsTool = createTool({
  id: "list_sub_agents",
  description:
    "List sub-agent profiles. REQUIRED before delegate_task — copy the exact id field into useAgentId. " +
    `For every create_app: delegate to id "${PRODUCT_ARCHITECT_DELEGATE_ID}" first (tool-enforced).`,
  // OpenAI function tools require parameters schema to always be an object.
  inputSchema: z.object({}),
  execute: async () => {
    const { getSubAgentService, toSubAgentListSummaries } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    const agents = await service.listAgents();
    const summaries = toSubAgentListSummaries(agents);
    const builtIn = summaries.filter((agent) => agent.builtIn);
    return {
      success: true,
      data: {
        count: summaries.length,
        /** Always use exact id — built-ins are seeded even if custom agents dominate the list */
        recommendedForAppBuild: PRODUCT_ARCHITECT_DELEGATE_ID,
        builtInAgents: builtIn,
        agents: summaries,
        hint:
          `${DELEGATE_TASK_EXAMPLE} — required before create_app (gate enforced). ` +
          "Wait for delegation to complete (get_delegation_run / MiniChat card) before create_plan or create_app.",
      },
    };
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
    return {
      success: true,
      data: agent,
      _delegationHint: `To delegate to this agent: delegate_task({ useAgentId: "${agent.id}", task: "...", context: "..." })`,
    };
  },
});

export const deleteSubAgentTool = createTool({
  id: "delete_sub_agent",
  description:
    "Delete a persistent sub-agent profile. Blocked when apps (agent chat) or subagent jobs still reference the profile unless force: true.",
  inputSchema: deleteSubAgentSchema,
  execute: async (input) => {
    const args = (input as { context?: DeleteSubAgentArgs }).context ?? input;
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");
    const service = getSubAgentService();
    try {
      const deleted = await service.deleteAgent(args.agentId, {
        force: args.force === true,
      });
      return { success: true, data: { agentId: args.agentId, deleted } };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
        }),
      );
    }
  },
});

export const delegateTaskTool = createTool({
  id: "delegate_task",
  description:
    "Delegate work to a sub-agent (background job + MiniChat). " +
    "REQUIRED before create_app: list_sub_agents() then " +
    `${DELEGATE_TASK_EXAMPLE}. ` +
    "Parameter name is useAgentId only — not agentId or subAgentId. Wait for completion before create_app.",
  inputSchema: delegateTaskSchema,
  execute: async (input) => {
    const raw = unwrapDelegateTaskRawInput(input);
    const validationError = buildDelegateTaskValidationError(raw);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        type: "validation_error" as const,
        data: {
          retryExample: DELEGATE_TASK_EXAMPLE,
          requiredField: "useAgentId",
          productArchitectId: PRODUCT_ARCHITECT_DELEGATE_ID,
        },
      };
    }

    const parsed = delegateTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        success: false,
        error: formatDelegateTaskZodError(parsed.error),
        type: "validation_error" as const,
        data: {
          retryExample: DELEGATE_TASK_EXAMPLE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      };
    }

    const args = parsed.data;
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
    const { getCurrentDelegationJobId } = await import("./context.js");
    const service = getSubAgentService();

    const delegationId =
      args.delegationId ?? getCurrentDelegationJobId() ?? undefined;

    if (delegationId) {
      // Block until main agent responds; return response so sub-agent can continue
      try {
        const response = await service.sendQuestionAndWaitForResponse(
          delegationId,
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
      delegationId,
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
