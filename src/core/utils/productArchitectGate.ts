/** Stable id for the built-in Product Architect sub-agent profile */
export const PRODUCT_ARCHITECT_ID = "product-architect";

export const PRODUCT_ARCHITECT_REMINDER =
  "Every create_app requires a completed product-architect delegation first (tool-enforced). " +
  'delegate_task({ useAgentId: "product-architect", task: "...", context: "..." }) — useAgentId only.';

export const PRODUCT_ARCHITECT_PLAN_REMINDER =
  "After product-architect completes, align create_plan with the approved brief, then build.";

export const PRODUCT_ARCHITECT_BLOCK_MESSAGE =
  "⛔ Product Architect required before this step.\n\n" +
  "Every new mini-app (create_app) requires a completed product-architect delegation in this chat — including simple CRUD apps.\n\n" +
  "1. list_sub_agents()\n" +
  '2. delegate_task({ useAgentId: "product-architect", task: "Product brief + architecture for: ...", context: "..." })\n' +
  "3. Wait for delegation to complete (MiniChat card or get_delegation_run)\n" +
  "4. create_plan aligned with the approved brief\n" +
  "5. create_app / create_job\n\n" +
  "Use exact field useAgentId — not agentId or subAgentId.\n\n" +
  "Reference: src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md";

/** Required Product Architect brief section — platform wiring the builder must follow. */
export const PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION =
  "## Implementation Contracts\n" +
  "- Builder MUST read_skill({ skillId: \"preloaded-app-and-jobs-guide\" }) before first backend/DB code edit\n" +
  "- Backend handlers: read params from PAPR_ACTION_PARAMS env (Python: json.loads(os.environ.get(\"PAPR_ACTION_PARAMS\", \"{}\"))) — NEVER sys.stdin\n" +
  "- Backend DB: from papr_db import connect (alias or active source) — NEVER sqlite3.connect, APP_DB_PATH, or raw os.environ DB paths\n" +
  "- Frontend → backend: body JSON.stringify({ params: { ... } }) — params must be nested\n" +
  "- Frontend ← backend: const { stdout, exitCode, stderr } = await res.json(); if (exitCode !== 0) throw; JSON.parse(stdout)\n" +
  "- Frontend DB reads: POST /api/db/query with { sourceId, sql, params } — field name is sql, not query\n" +
  "- Frontend DB writes: POST /api/db/write (not /api/db/query for INSERT/UPDATE/DELETE)\n" +
  "- Plan A schema (cloud sync on): write_file migrations/{id}.sql → papr_db_apply_migration({ dbId, migrationId }) — Turso primary when online; never papr_db_exec DDL or bash/sqlite3 on registry DB files\n" +
  "- Plan A rows: papr_db_exec DML or /api/db/write; Upload now / push_cloud_sync({ appId }) ships git + Turso ordered flush — not legacy CDC\n" +
  "- Platform scrape jobs: LinkedIn only → linkedin-api + CDP (desktop); X/Reddit/Instagram → \\${KEY} + headless Playwright — never reddit-api/x-api CDP; cloud uses vault-synced cookies\n" +
  "- Extend backend/ping.py scaffold pattern — do not replace with stdin-based handlers";

/** Returned on create_app after product-architect gate passes — reminds builder of platform contracts. */
export const CREATE_APP_IMPLEMENTATION_REMINDER =
  "⚠️ IMPLEMENTATION CONTRACTS: Before backend/DB code, read_skill({ skillId: \"preloaded-app-and-jobs-guide\" }). " +
  "Backend: PAPR_ACTION_PARAMS (not sys.stdin), papr_db.connect() (not sqlite3.connect / APP_DB_PATH). " +
  "Frontend backend calls: JSON.stringify({ params: {...} }); parse stdout + check exitCode. " +
  "/api/db/query uses sql (not query). Mirror backend/ping.py from the app scaffold.";

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
