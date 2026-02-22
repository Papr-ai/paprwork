import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type {
  DelegateTaskInput,
  DelegationRunRecord,
  SubAgentProfile,
} from "../../core/types/subagents.js";
import type { Provider } from "../../core/types/agents.js";
import { getJobsService } from "./JobsService.js";
import type { JobRecord, JobStatus } from "./jobs/types.js";
import type { StoredMessage } from "./storage/IStorageProvider.js";

/** Chat ID prefix for delegation sub-agent ↔ main-agent conversations */
export const DELEGATION_CHAT_PREFIX = "delegation:";

/** Max time to wait for main-agent response (ms) */
const RESPONSE_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingQuestion {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CreateSubAgentInput {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: Provider;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
  icon?: import("../../core/types/subagents.js").SubAgentIconName;
}

let subAgentServiceInstance: SubAgentService | null = null;

const DEFAULT_SUB_AGENTS: Array<
  Omit<SubAgentProfile, "createdAt" | "updatedAt" | "runCount">
> = [
  {
    id: "research-specialist",
    name: "Research Specialist",
    description: "Investigates and summarizes complex topics",
    systemPrompt:
      "You are a focused research sub-agent. Gather evidence, summarize clearly, and highlight uncertainty.",
    provider: "openai",
    model: "gpt-5.2",
    allowedToolIds: [
      "bash",
      "read_file",
      "search_files",
      "search_agent_memory",
    ],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: 12,
    memoryPolicy: "summary",
    icon: "search",
    lastRunAt: undefined,
  },
  {
    id: "implementation-specialist",
    name: "Implementation Specialist",
    description: "Implements and validates code changes",
    systemPrompt:
      "You are a coding sub-agent. Produce practical implementation steps and validate outcomes.",
    provider: "openai",
    model: "gpt-5.2",
    allowedToolIds: [
      "bash",
      "read_file",
      "write_file",
      "search_files",
      "search_agent_memory",
    ],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: 12,
    memoryPolicy: "summary",
    icon: "code",
    lastRunAt: undefined,
  },
];

export class SubAgentService {
  private profilePath: string;
  private legacyRunsPath: string;
  private profiles: Map<string, SubAgentProfile>;
  private legacyRuns: Map<string, DelegationRunRecord>;
  private initialized: boolean;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();

  constructor() {
    const root = path.join(os.homedir(), "PAPR", "data");
    this.profilePath = path.join(root, "subagents.json");
    this.legacyRunsPath = path.join(root, "subagent-runs.json");
    this.profiles = new Map();
    this.legacyRuns = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.profilePath), { recursive: true });
    await Promise.all([this.loadProfiles(), this.loadLegacyRuns()]);
    await this.migrateLegacyRunsIfNeeded();
    await this.ensureDefaultProfiles();
    this.initialized = true;
  }

  private async migrateLegacyRunsIfNeeded(): Promise<void> {
    if (this.legacyRuns.size === 0) {
      return;
    }
    const jobsService = getJobsService();
    await jobsService.initialize();
    for (const legacy of this.legacyRuns.values()) {
      const migratedId = `legacy-${legacy.id}`;
      const existing = await jobsService.getJob(migratedId);
      if (existing) {
        continue;
      }
      const status: JobStatus =
        legacy.status === "completed"
          ? "completed"
          : legacy.status === "running"
            ? "running"
            : legacy.status === "pending"
              ? "pending"
              : "failed";
      const now = new Date().toISOString();
      const record: JobRecord = {
        id: migratedId,
        name: `Migrated delegation ${legacy.agentId}`,
        type: "subagent",
        status,
        command: legacy.task,
        subAgentId: legacy.agentId,
        delegationTask: legacy.task,
        delegationContext: legacy.context,
        reportChatId: legacy.reportChatId,
        createdAt: legacy.createdAt ?? now,
        updatedAt: legacy.completedAt ?? legacy.startedAt ?? now,
        lastRunAt: legacy.startedAt,
        completedAt: legacy.completedAt,
        error: legacy.error,
        retries: { maxAttempts: 1, backoffMs: 1000 },
        retentionDays: 14,
      };
      await jobsService.upsertJob(record);
    }
  }

  private async loadProfiles(): Promise<void> {
    try {
      const raw = await fs.readFile(this.profilePath, "utf8");
      const list = JSON.parse(raw) as SubAgentProfile[];
      this.profiles = new Map(list.map((item) => [item.id, item]));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.error("[SubAgentService] Failed to load profiles:", error);
      }
      this.profiles = new Map();
    }
  }

  private async loadLegacyRuns(): Promise<void> {
    try {
      const raw = await fs.readFile(this.legacyRunsPath, "utf8");
      const list = JSON.parse(raw) as DelegationRunRecord[];
      this.legacyRuns = new Map(list.map((item) => [item.id, item]));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.error("[SubAgentService] Failed to load legacy runs:", error);
      }
      this.legacyRuns = new Map();
    }
  }

  private async saveProfiles(): Promise<void> {
    const list = Array.from(this.profiles.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    await fs.writeFile(this.profilePath, JSON.stringify(list, null, 2), "utf8");
  }

  private async ensureDefaultProfiles(): Promise<void> {
    const now = new Date().toISOString();
    let changed = false;
    for (const base of DEFAULT_SUB_AGENTS) {
      if (this.profiles.has(base.id)) continue;
      this.profiles.set(base.id, {
        ...base,
        createdAt: now,
        updatedAt: now,
        runCount: 0,
      });
      changed = true;
    }
    if (changed) {
      await this.saveProfiles();
    }
  }

  async listAgents(): Promise<SubAgentProfile[]> {
    await this.initialize();
    return Array.from(this.profiles.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async getAgent(agentId: string): Promise<SubAgentProfile | null> {
    await this.initialize();
    return this.profiles.get(agentId) ?? null;
  }

  async createOrUpdateAgent(
    input: CreateSubAgentInput,
  ): Promise<SubAgentProfile> {
    await this.initialize();
    const id = input.id?.trim() || `agent-${uuidv4()}`;
    const existing = this.profiles.get(id);
    const now = new Date().toISOString();
    const profile: SubAgentProfile = {
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      systemPrompt: input.systemPrompt.trim(),
      provider: input.provider,
      model: input.model,
      allowedToolIds: input.allowedToolIds,
      assignedSkills: input.assignedSkills ?? existing?.assignedSkills ?? [],
      outputMode: input.outputMode ?? existing?.outputMode ?? "natural",
      outputSchema: input.outputSchema ?? existing?.outputSchema,
      maxTurns: input.maxTurns ?? existing?.maxTurns ?? 12,
      memoryPolicy: input.memoryPolicy ?? existing?.memoryPolicy ?? "summary",
      icon: input.icon ?? existing?.icon,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      runCount: existing?.runCount ?? 0,
      lastRunAt: existing?.lastRunAt,
    };
    this.profiles.set(id, profile);
    await this.saveProfiles();
    return profile;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    await this.initialize();
    const deleted = this.profiles.delete(agentId);
    if (deleted) {
      await this.saveProfiles();
    }
    return deleted;
  }

  async listRuns(limit = 50): Promise<DelegationRunRecord[]> {
    await this.initialize();
    const jobsService = getJobsService();
    await jobsService.initialize();
    const jobs = await jobsService.listJobs();
    const delegated = jobs
      .filter((job) => job.type === "subagent")
      .map((job) => this.mapJobToRun(job))
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    const legacy = Array.from(this.legacyRuns.values()).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return [...delegated, ...legacy].slice(0, limit);
  }

  async getDashboard(limit = 100): Promise<{
    totalAgents: number;
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    runningRuns: number;
    successRate: number;
    topAgents: Array<{
      agentId: string;
      runs: number;
      completed: number;
      failed: number;
      successRate: number;
    }>;
    recentRuns: DelegationRunRecord[];
  }> {
    const agents = await this.listAgents();
    const runs = await this.listRuns(limit);
    const completedRuns = runs.filter(
      (run) => run.status === "completed",
    ).length;
    const failedRuns = runs.filter((run) => run.status === "failed").length;
    const runningRuns = runs.filter((run) => run.status === "running").length;
    const totalRuns = runs.length;
    const successRate =
      totalRuns > 0 ? Number((completedRuns / totalRuns).toFixed(2)) : 0;

    const statsByAgent = new Map<
      string,
      { runs: number; completed: number; failed: number }
    >();
    for (const run of runs) {
      const current = statsByAgent.get(run.agentId) ?? {
        runs: 0,
        completed: 0,
        failed: 0,
      };
      current.runs += 1;
      if (run.status === "completed") current.completed += 1;
      if (run.status === "failed") current.failed += 1;
      statsByAgent.set(run.agentId, current);
    }
    const topAgents = Array.from(statsByAgent.entries())
      .map(([agentId, stats]) => ({
        agentId,
        runs: stats.runs,
        completed: stats.completed,
        failed: stats.failed,
        successRate:
          stats.runs > 0
            ? Number((stats.completed / stats.runs).toFixed(2))
            : 0,
      }))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 8);

    return {
      totalAgents: agents.length,
      totalRuns,
      completedRuns,
      failedRuns,
      runningRuns,
      successRate,
      topAgents,
      recentRuns: runs.slice(0, 20),
    };
  }

  async getRun(runId: string): Promise<DelegationRunRecord | null> {
    await this.initialize();
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.getJob(runId);
    if (job && job.type === "subagent") {
      return this.mapJobToRun(job);
    }
    return this.legacyRuns.get(runId) ?? null;
  }

  private mapStatus(status: JobStatus): DelegationRunRecord["status"] {
    if (status === "pending") return "pending";
    if (status === "running") return "running";
    if (status === "completed") return "completed";
    return "failed";
  }

  private mapJobToRun(job: JobRecord): DelegationRunRecord {
    const agentName =
      job.name?.replace(/^Delegation: /, "").trim() || undefined;
    const profile = job.subAgentId
      ? this.profiles.get(job.subAgentId)
      : undefined;
    return {
      id: job.id,
      agentId: job.subAgentId ?? "unknown",
      agentName,
      agentIcon: profile?.icon,
      task: job.delegationTask ?? job.command ?? "",
      context: job.delegationContext,
      status: this.mapStatus(job.status),
      reportChatId: job.reportChatId ?? job.deliver?.targetId,
      createdAt: job.createdAt,
      startedAt: job.lastRunAt,
      completedAt: job.completedAt,
      resultText: job.lastOutput,
      error: job.error,
    };
  }

  /**
   * Resolve sub-agent by id or by name (case-insensitive).
   * Handles agent passing display name (e.g. "Strategic Question Agent") instead of id.
   */
  private resolveSubAgent(
    profiles: SubAgentProfile[],
    useAgentId: string | undefined,
  ): SubAgentProfile | null {
    if (!useAgentId?.trim()) return profiles[0] ?? null;
    const id = useAgentId.trim();
    // Exact id match
    const byId = profiles.find((p) => p.id === id);
    if (byId) return byId;
    // Case-insensitive name match (handles "Strategic Question Agent" vs "Strategic Question Agent")
    const byName = profiles.find(
      (p) => p.name.toLowerCase() === id.toLowerCase(),
    );
    if (byName) return byName;
    // Normalized id match: "strategic question agent" -> "strategic-question-agent"
    const normalized = id.toLowerCase().replace(/\s+/g, "-");
    const byNormalized = profiles.find(
      (p) => p.id.toLowerCase() === normalized,
    );
    if (byNormalized) return byNormalized;
    return null;
  }

  async delegateTask(input: DelegateTaskInput): Promise<DelegationRunRecord> {
    await this.initialize();
    const profiles = await this.listAgents();
    if (profiles.length === 0) {
      throw new Error("No sub-agents available");
    }
    const selected = this.resolveSubAgent(profiles, input.useAgentId);
    if (!selected) {
      throw new Error(
        `Sub-agent not found: ${input.useAgentId ?? "(none)"}. ` +
          `Available: ${profiles.map((p) => `${p.id} (${p.name})`).join(", ")}`,
      );
    }

    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.createJob({
      name: `Delegation: ${selected.name}`,
      type: "subagent",
      subAgentId: selected.id,
      delegatedBy: "main-agent",
      delegationTask: input.task,
      delegationContext: input.context,
      command: input.task,
      outputMode: input.outputMode ?? selected.outputMode ?? "natural",
      outputSchema: input.outputSchema ?? selected.outputSchema,
      maxTurns: input.maxTurns ?? selected.maxTurns ?? 12,
      memoryPolicy: input.memoryPolicy ?? selected.memoryPolicy ?? "summary",
      reportChatId: input.reportChatId,
      deliver:
        input.reportChatId && input.reportChatId.trim().length > 0
          ? { channel: "chat", targetId: input.reportChatId }
          : undefined,
    });

    if (input.background) {
      void jobsService.runJob(job.id);
      return this.mapJobToRun(job);
    }
    const completed = await jobsService.runJob(job.id);
    const now = new Date().toISOString();
    this.profiles.set(selected.id, {
      ...selected,
      runCount: selected.runCount + 1,
      lastRunAt: now,
      updatedAt: now,
    });
    await this.saveProfiles();
    return this.mapJobToRun(completed);
  }

  // ===== Multi-Turn Sub-Agent Communication =====

  /** Get chat ID for delegation sub-agent ↔ main-agent conversation */
  getDelegationChatId(delegationId: string): string {
    return `${DELEGATION_CHAT_PREFIX}${delegationId}`;
  }

  /**
   * Save message to delegation chat (chat DB + Papr memory via StorageManager)
   */
  private async saveToDelegationChat(
    delegationId: string,
    message: Omit<StoredMessage, "chat_id" | "sync_status"> & {
      sync_status?: StoredMessage["sync_status"];
    },
  ): Promise<void> {
    const chatId = this.getDelegationChatId(delegationId);
    const { getAgentService } = await import("./AgentService.js");
    const storage = getAgentService().getStorageManager();
    const fullMsg: StoredMessage = {
      ...message,
      chat_id: chatId,
      sync_status: message.sync_status ?? "local",
    };
    await storage.saveMessage(chatId, fullMsg);
  }

  /**
   * Send question from sub-agent to main agent and wait for response.
   * Saves to delegation chat (chat DB + Papr memory), broadcasts, triggers main agent,
   * then blocks until main agent/user responds or timeout.
   */
  async sendQuestionAndWaitForResponse(
    delegationId: string,
    question: string,
    urgency: "low" | "medium" | "high",
  ): Promise<string> {
    let sourceAgentId: string | undefined;
    let sourceAgentName: string | undefined;
    try {
      const jobsService = getJobsService();
      const job = await jobsService.getJob(delegationId);
      if (job?.subAgentId) {
        const profile = this.profiles.get(job.subAgentId);
        sourceAgentId = job.subAgentId;
        sourceAgentName = profile?.name ?? job.subAgentId;
      }
    } catch {
      // Ignore - use defaults
    }
    console.log(
      `[SubAgentService] Sub-agent question (waiting): ${question} (delegationId: ${delegationId})`,
    );

    // Save question to delegation chat (chat DB + Papr memory)
    await this.saveToDelegationChat(delegationId, {
      id: `msg-${uuidv4()}`,
      role: "assistant",
      content: question,
      timestamp: new Date().toISOString(),
      source_agent_id: sourceAgentId,
      source_agent_name: sourceAgentName,
    });

    const { broadcast } = await import("../websocket/index.js");
    broadcast({
      type: "subagent-chat:question",
      data: {
        question,
        urgency,
        delegationId,
        timestamp: new Date().toISOString(),
      },
    });

    // Trigger main agent to automatically respond
    const { triggerMainAgentResponse } =
      await import("./SubAgentResponseTrigger.js");
    void triggerMainAgentResponse(delegationId, question);

    // Block until response or timeout
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(delegationId);
        reject(
          new Error(
            `Timeout waiting for main-agent response (${RESPONSE_WAIT_TIMEOUT_MS / 1000}s)`,
          ),
        );
      }, RESPONSE_WAIT_TIMEOUT_MS);

      this.pendingQuestions.set(delegationId, {
        resolve,
        reject,
        timeout,
      });
    });
  }

  /**
   * Send question from sub-agent to main agent (fire-and-forget, no wait)
   */
  async sendQuestionToMainAgent(
    question: string,
    urgency: "low" | "medium" | "high",
    delegationId?: string,
  ): Promise<void> {
    console.log(
      `[SubAgentService] Sub-agent question: ${question} (urgency: ${urgency}, delegationId: ${delegationId ?? "none"})`,
    );

    const { broadcast } = await import("../websocket/index.js");
    broadcast({
      type: "subagent-chat:question",
      data: {
        question,
        urgency,
        delegationId,
        timestamp: new Date().toISOString(),
      },
    });

    if (delegationId) {
      const { triggerMainAgentResponse } =
        await import("./SubAgentResponseTrigger.js");
      void triggerMainAgentResponse(delegationId, question);
    }
  }

  /**
   * Main agent or user responds to sub-agent question.
   * Saves to delegation chat (chat DB + Papr memory), broadcasts, and unblocks
   * the waiting sub-agent so it can continue with the response.
   */
  async respondToSubAgent(
    delegationId: string,
    message: string,
    author: "main-agent" | "user" = "main-agent",
  ): Promise<void> {
    console.log(
      `[SubAgentService] ${author} responding to ${delegationId}: ${message}`,
    );

    // Save response to delegation chat (chat DB + Papr memory)
    await this.saveToDelegationChat(delegationId, {
      id: `msg-${uuidv4()}`,
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
      source_agent_id: author,
      source_agent_name: author === "main-agent" ? "Main Agent" : "User",
    });

    // Broadcast to UI
    const { broadcast } = await import("../websocket/index.js");
    broadcast({
      type: "subagent-chat:message",
      data: {
        delegationId,
        message: {
          role: "user",
          author,
          content: message,
          timestamp: new Date().toISOString(),
        },
      },
    });

    // Unblock waiting sub-agent (if any)
    const pending = this.pendingQuestions.get(delegationId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingQuestions.delete(delegationId);
      pending.resolve(message);
    }

    // When user sends, trigger sub-agent to respond (not main agent)
    if (author === "user") {
      // Resume the sub-agent job so it can respond to user's message
      const jobsService = getJobsService();
      const job = await jobsService.getJob(delegationId);
      if (job && job.status === "running") {
        console.log(
          `[SubAgentService] User sent message to running delegation ${delegationId}, sub-agent will receive it in its session`,
        );
        // The sub-agent's session is already running and will see this message
        // via loadDelegationChatMessages() or sendQuestionAndWaitForResponse()
        // No additional trigger needed - the response is already in the delegation chat
      }
    }
  }

  /**
   * Load delegation chat messages (for UI or debugging)
   */
  async loadDelegationChatMessages(
    delegationId: string,
    limit = 50,
  ): Promise<StoredMessage[]> {
    const chatId = this.getDelegationChatId(delegationId);
    const { getAgentService } = await import("./AgentService.js");
    const storage = getAgentService().getStorageManager();
    return storage.loadMessages(chatId, limit, 0);
  }

  /**
   * Sub-agent marks delegation as complete
   * Closes session and returns result
   */
  async completeDelegation(result: string, summary?: string): Promise<void> {
    console.log(
      `[SubAgentService] Completing delegation with result (${result.length} chars)`,
    );

    // TODO: Get current delegation context and mark job as completed
    // For now, this is a placeholder

    const { broadcast } = await import("../websocket/index.js");
    broadcast({
      type: "subagent-chat:completed",
      data: {
        result,
        summary,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

export function getSubAgentService(): SubAgentService {
  if (!subAgentServiceInstance) {
    subAgentServiceInstance = new SubAgentService();
  }
  return subAgentServiceInstance;
}

export async function initializeSubAgentService(): Promise<SubAgentService> {
  const service = getSubAgentService();
  await service.initialize();
  return service;
}
