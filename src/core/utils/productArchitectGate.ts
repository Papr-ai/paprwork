/** Stable id for the built-in Product Architect sub-agent profile */
export const PRODUCT_ARCHITECT_ID = "product-architect";

export const PRODUCT_ARCHITECT_REMINDER =
  "For app+job automation, delegate_task({ useAgentId: \"product-architect\", ... }) runs BEFORE create_app/create_job (enforced).";

export const PRODUCT_ARCHITECT_PLAN_REMINDER =
  "After product-architect completes, align create_plan with the approved brief, then build.";

export const PRODUCT_ARCHITECT_BLOCK_MESSAGE =
  "⛔ Product Architect required before this step.\n\n" +
  "Complex app+job work must start with a completed product-architect delegation in this chat:\n" +
  '1. delegate_task({ useAgentId: "product-architect", task: "...", context: "..." })\n' +
  "2. Wait for completion (get_delegation_run or delegation card)\n" +
  "3. create_plan aligned with the approved brief\n" +
  "4. Then create_app / create_job\n\n" +
  "Reference: src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md";

export interface ProductArchitectGateInput {
  tool: "create_app" | "create_job";
  jobType?: string;
  appIds?: readonly string[];
  schedule?: { enabled?: boolean | null };
  dependsOn?: readonly unknown[];
}

export function requiresProductArchitectApproval(
  input: ProductArchitectGateInput,
): boolean {
  if (input.tool === "create_app") {
    return true;
  }

  const linkedApps = (input.appIds ?? []).filter(
    (appId) => appId !== "__standalone__",
  );
  if (linkedApps.length > 0) {
    return true;
  }
  if (input.schedule?.enabled) {
    return true;
  }
  if (input.dependsOn && input.dependsOn.length > 0) {
    return true;
  }
  if (input.jobType === "agent" || input.jobType === "subagent") {
    return true;
  }

  return false;
}

interface DelegateToolCallRow {
  name?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string | Record<string, unknown>;
}

function readDelegateAgentId(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  const raw =
    args.useAgentId ?? args.agentId ?? args.subAgentId ?? args.use_agent_id;
  return typeof raw === "string" ? raw.trim() : "";
}

function parseDelegateResult(
  result: string | Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  if (typeof result === "object") {
    return result;
  }
  try {
    return JSON.parse(result) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isCompletedProductArchitectDelegation(
  toolCall: DelegateToolCallRow,
): boolean {
  const toolName = toolCall.name ?? toolCall.toolName;
  if (toolName !== "delegate_task") {
    return false;
  }
  if (readDelegateAgentId(toolCall.args) !== PRODUCT_ARCHITECT_ID) {
    return false;
  }

  const parsed = parseDelegateResult(toolCall.result);
  if (!parsed) {
    return false;
  }

  const data = (parsed.data as Record<string, unknown> | undefined) ?? parsed;
  const status = String(data.status ?? parsed.status ?? "").toLowerCase();
  if (status === "completed" || status === "success") {
    return true;
  }
  if (parsed.success === true && typeof data.resultText === "string") {
    return data.resultText.trim().length > 0;
  }

  return false;
}

function isCompletedProductArchitectFromGetRun(
  toolCall: DelegateToolCallRow,
): boolean {
  const toolName = toolCall.name ?? toolCall.toolName;
  if (toolName !== "get_delegation_run") {
    return false;
  }

  const parsed = parseDelegateResult(toolCall.result);
  if (!parsed) {
    return false;
  }

  const data = (parsed.data as Record<string, unknown> | undefined) ?? parsed;
  const agentId = String(data.agentId ?? "").trim();
  if (agentId !== PRODUCT_ARCHITECT_ID) {
    return false;
  }

  const status = String(data.status ?? parsed.status ?? "").toLowerCase();
  return status === "completed" || status === "success";
}

async function hasCompletedProductArchitectJob(
  chatId: string,
): Promise<boolean> {
  const { getJobsService } = await import(
    "../../gateway/services/JobsService.js"
  );
  const jobsService = getJobsService();
  await jobsService.initialize();
  const jobs = await jobsService.listJobs();

  return jobs.some(
    (job) =>
      job.type === "subagent" &&
      job.subAgentId === PRODUCT_ARCHITECT_ID &&
      job.reportChatId === chatId &&
      job.status === "completed",
  );
}

export async function hasCompletedProductArchitectInChat(
  chatId: string,
): Promise<boolean> {
  const { getAgentService } = await import(
    "../../gateway/services/AgentService.js"
  );
  const messages = await getAgentService()
    .getStorageManager()
    .loadMessages(chatId);

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    for (const toolCall of message.toolCalls as DelegateToolCallRow[]) {
      if (
        isCompletedProductArchitectDelegation(toolCall) ||
        isCompletedProductArchitectFromGetRun(toolCall)
      ) {
        return true;
      }
    }
  }

  return hasCompletedProductArchitectJob(chatId);
}

export async function assertProductArchitectGate(
  chatId: string | null | undefined,
  input: ProductArchitectGateInput,
): Promise<{ allowed: true } | { allowed: false; message: string }> {
  if (!requiresProductArchitectApproval(input)) {
    return { allowed: true };
  }
  if (!chatId) {
    return {
      allowed: false,
      message:
        `${PRODUCT_ARCHITECT_BLOCK_MESSAGE}\n\n(No active chat context — cannot verify product-architect completion.)`,
    };
  }

  const completed = await hasCompletedProductArchitectInChat(chatId);
  if (completed) {
    return { allowed: true };
  }

  return { allowed: false, message: PRODUCT_ARCHITECT_BLOCK_MESSAGE };
}
