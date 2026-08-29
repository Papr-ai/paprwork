import { promises as fs } from "fs";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type {
  DelegateTaskInput,
  DelegationRunRecord,
  SubAgentProfile,
} from "../../core/types/subagents.js";
import type { Provider } from "../../core/types/agents.js";
import { getJobsService, STANDALONE_APP_ID } from "./JobsService.js";
import type { JobRecord, JobStatus } from "./jobs/types.js";
import type { StoredMessage } from "./storage/IStorageProvider.js";
import { DEFAULT_AGENT_MAX_TURNS } from "../../core/constants/agentLimits.js";
import { PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION } from "../../core/utils/productArchitectGate.js";
import {
  collectSubAgentReferences,
  formatOrphanedSubAgentWarning,
  findOrphanedSubAgentReferences,
  reconcileSubAgentProfilesOnDisk,
} from "./subagents/subAgentIntegrity.js";
import { listCustomSubAgentConfigEntries } from "./subagents/subAgentMetadataSlice.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";

/** Chat ID prefix for delegation sub-agent ↔ main-agent conversations */
export const DELEGATION_CHAT_PREFIX = "delegation:";

/** Max time to wait for main-agent response (ms) */
const RESPONSE_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ResolveSubAgentResult {
  profile: SubAgentProfile | null;
  error?: string;
}

function formatAgentList(profiles: SubAgentProfile[]): string {
  return profiles.map((p) => `${p.id} (${p.name})`).join(", ");
}

/**
 * Resolve a sub-agent profile by id, name, or normalized slug.
 * Never falls back to the first agent — useAgentId must be explicit.
 */
export function resolveSubAgentProfile(
  profiles: SubAgentProfile[],
  useAgentId: string | undefined,
): ResolveSubAgentResult {
  if (profiles.length === 0) {
    return { profile: null, error: "No sub-agents available" };
  }

  if (!useAgentId?.trim()) {
    return {
      profile: null,
      error:
        "useAgentId is required. Call list_sub_agents() first, then pass the exact id field " +
        `(not the display name). Available: ${formatAgentList(profiles)}`,
    };
  }

  const query = useAgentId.trim();

  const byId = profiles.find((p) => p.id === query);
  if (byId) return { profile: byId };

  const byExactName = profiles.filter(
    (p) => p.name.toLowerCase() === query.toLowerCase(),
  );
  if (byExactName.length === 1) return { profile: byExactName[0] };
  if (byExactName.length > 1) {
    return {
      profile: null,
      error: `Ambiguous name "${query}". Use exact id: ${byExactName.map((p) => p.id).join(", ")}`,
    };
  }

  const normalized = query.toLowerCase().replace(/\s+/g, "-");
  const byNormalized = profiles.filter((p) => p.id.toLowerCase() === normalized);
  if (byNormalized.length === 1) return { profile: byNormalized[0] };

  if (query.length >= 8) {
    const fragment = query.toLowerCase();
    const byFragment = profiles.filter((p) =>
      p.id.toLowerCase().includes(fragment),
    );
    if (byFragment.length === 1) return { profile: byFragment[0] };
    if (byFragment.length > 1) {
      return {
        profile: null,
        error:
          `Ambiguous id fragment "${query}". Use full id from list_sub_agents(): ` +
          byFragment.map((p) => `${p.id} (${p.name})`).join("; "),
      };
    }
  }

  const queryLower = query.toLowerCase();
  const byPartialName = profiles.filter((p) => {
    const nameLower = p.name.toLowerCase();
    return nameLower.includes(queryLower) || queryLower.includes(nameLower);
  });
  if (byPartialName.length === 1) return { profile: byPartialName[0] };
  if (byPartialName.length > 1) {
    return {
      profile: null,
      error:
        `Ambiguous agent "${query}". Use exact id from list_sub_agents(): ` +
        byPartialName.map((p) => `${p.id} (${p.name})`).join("; "),
    };
  }

  return {
    profile: null,
    error: `Sub-agent not found: "${query}". Available: ${formatAgentList(profiles)}`,
  };
}

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
  fallbackProvider?: Provider;
  fallbackModel?: string;
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
    model: "gpt-5.4-mini",
    allowedToolIds: [
      "bash",
      "read_file",
      "search_files",
      "search_agent_memory",
    ],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    memoryPolicy: "none",
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
    model: "gpt-5.4-mini",
    allowedToolIds: [
      "bash",
      "read_file",
      "write_file",
      "search_files",
      "search_agent_memory",
    ],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    memoryPolicy: "none",
    icon: "code",
    lastRunAt: undefined,
  },
  {
    id: "product-architect",
    name: "Product Architect",
    description:
      "Product brief + Paprwork architecture (lightweight PRD: scope, schema, jobs, UI plan) before build — not a separate PRD agent",
    systemPrompt: `You are the Paprwork Product Architect sub-agent. You do NOT write mini-app code or call create_app/create_job.

Your job: produce a product brief and Paprwork-specific architecture for the main agent to validate with the user BEFORE implementation.

REQUIRED FIRST STEPS:
1. read_skill({ skillId: "preloaded-app-and-jobs-guide" })
2. read_skill({ skillId: "preloaded-paprwork-design-system" })
3. list_apps() and list_jobs() when relevant
4. read_file({ path: "src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md" })
5. read_file({ path: "src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md" }) for a full worked example to mirror

OUTPUT (use all sections):
## Product Brief — job-to-be-done, scope, success criteria
## Page map — one user task per page; multiple pages per app OK; split apps when workflows/audiences differ (see PRODUCT_ARCHITECT_GUIDE § Apps vs pages)
## Paprwork Architecture — mini-apps (modes), backend handlers, jobs (types, schedules, appIds, dependsOn), shared SQLite schema + table design (entities, facts, aggregates), data flow
### Backend Handlers (REQUIRED subsection)
List each POST /api/app/backend/:action or explicitly justify skipping ("read-only dashboard with 1-2 SELECTs, no secrets, no external APIs").
Backend handlers are needed for: 3+ DB operations (CRUD), vault/API keys, external API calls, server-side validation, file operations, multi-table transactions — NOT just SQL.
If the app calls ANY external API with secrets, those calls MUST go through backend handlers (never fetch() with API keys from the browser).
## Implementation Contracts (REQUIRED — copy checklist for builder)
${PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION}
## Cloud Read Budget — estimated rows read per page; aggregate tables (app_stats) for KPIs, not runtime COUNT(*) from frontend
## Plan A Cloud DB (when linked DBs + cloud sync) — list migrations/{id}.sql in schema; builder applies via papr_db_apply_migration (Turso primary); rows via DML only; Upload now for git + replica push
## Design System — one task per page, 2-3 sections per page, ONE primary action per page, Liquid Glass + brand
## Phased Plan — Phase 1 MVP, later phases
## Risks & Open Questions
## Recommendation — proceed / simplify / defer

RULES:
- One user task per page; one related workflow per app; 2-3 apps when jobs/audiences are totally different (not "one more tab")
- Entity + fact + aggregate tables in one DB — job writes aggregates, app reads rows (see PRODUCT_ARCHITECT_GUIDE § Table design)
- Agent jobs for LLM work; python/node for fixed pipelines only
- Every job needs appIds; custom keys via \${KEY_NAME} in command strings only
- Mini-apps use window.paprAPI (browser context, not Node fs)
- Never recommend spaghetti (50+ files in one app)
- Backend handlers for ANY server-side logic: DB CRUD, external APIs, vault secrets, auth, file ops — not just SQL
- Plan A (cloud sync on): schema changes = migration files + papr_db_apply_migration only — never papr_db_exec DDL or bash/sqlite3 on registry DB paths

TURN BUDGET: Up to ${DEFAULT_AGENT_MAX_TURNS} tool steps (same as main agent). After investigation, STOP calling tools and deliver the FULL document as your final assistant message — not "let me check..." planning text.

DELIVERY: Your final assistant message text is auto-delivered to the main chat. Include all required sections in that message.`,
    provider: "anthropic",
    model: "claude-opus-4-6",
    fallbackProvider: "openai",
    fallbackModel: "gpt-5-6-sol",
    allowedToolIds: [
      "bash",
      "read_file",
      "search_files",
      "search_agent_memory",
      "list_apps",
      "list_jobs",
      "read_skill",
      "get_project_code_overview",
      "list_file_code_summaries",
      "get_file_code_summary",
      "request_agent_input",
      "complete_delegation",
    ],
    assignedSkills: ["preloaded-app-and-jobs-guide", "preloaded-paprwork-design-system"],
    outputMode: "natural",
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    memoryPolicy: "none",
    icon: "pen",
    lastRunAt: undefined,
  },
];

/** Built-in sub-agent ids seeded on gateway startup (always available unless deleted). */
export const BUILTIN_SUB_AGENT_IDS: readonly string[] = DEFAULT_SUB_AGENTS.map(
  (profile) => profile.id,
);

export const BUILTIN_SUB_AGENT_ID_SET = new Set<string>(BUILTIN_SUB_AGENT_IDS);

export interface SubAgentListSummary {
  id: string;
  name: string;
  description: string;
  icon?: SubAgentProfile["icon"];
  builtIn: boolean;
}

/** Compact listing for list_sub_agents — omits systemPrompt to avoid truncation. */
export function toSubAgentListSummaries(
  profiles: SubAgentProfile[],
): SubAgentListSummary[] {
  const sorted = [...profiles].sort((a, b) => {
    const aBuiltIn = BUILTIN_SUB_AGENT_ID_SET.has(a.id);
    const bBuiltIn = BUILTIN_SUB_AGENT_ID_SET.has(b.id);
    if (aBuiltIn !== bBuiltIn) return aBuiltIn ? -1 : 1;
    if (a.id === "product-architect") return -1;
    if (b.id === "product-architect") return 1;
    return a.name.localeCompare(b.name);
  });
  return sorted.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    icon: profile.icon,
    builtIn: BUILTIN_SUB_AGENT_ID_SET.has(profile.id),
  }));
}

export class SubAgentService {
  private profilePath: string;
  private legacyRunsPath: string;
  private profiles: Map<string, SubAgentProfile>;
  private legacyRuns: Map<string, DelegationRunRecord>;
  private initialized: boolean;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();

  constructor() {
    const root = getPaprDataDir();
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
    await this.reconcileIntegrityAfterLoad();
    void this.uploadCustomProfilesToCloud();
    this.initialized = true;
  }

  /** Dual-write custom profiles to Mongo (Phase 4.6) — backfill on init + after saves. */
  private uploadCustomProfilesToCloud(updatedAt?: string): void {
    const list = listCustomSubAgentConfigEntries(
      Array.from(this.profiles.values()),
    );
    if (list.length === 0) {
      return;
    }
    const resolvedUpdatedAt =
      updatedAt ??
      (list.reduce((latest, profile) => {
        const candidate = profile.updatedAt ?? profile.createdAt ?? "";
        return candidate > latest ? candidate : latest;
      }, "") || new Date().toISOString());
    void import("./syncV3/MetadataRegistryClient.js")
      .then(({ uploadSubAgentsIndexToCloud }) =>
        uploadSubAgentsIndexToCloud(list, resolvedUpdatedAt),
      )
      .catch((err: Error) => {
        console.warn(
          "[SubAgentService] subagents index cloud upload failed:",
          err.message.slice(0, 120),
        );
      });
  }

  /** Reload profiles from disk (after git pull merge / sidecar recovery). */
  async reloadProfilesFromDisk(): Promise<void> {
    await this.loadProfiles();
    await this.ensureDefaultProfiles();
    await this.reconcileIntegrityAfterLoad();
  }

  private async reconcileIntegrityAfterLoad(): Promise<void> {
    try {
      const paprDir = getPaprRoot();
      const result = await reconcileSubAgentProfilesOnDisk(paprDir);
      if (result.recoveredFromSidecar.length > 0) {
        console.warn(
          `[SubAgentService] Recovered sub-agent profile(s) from agent-chat sidecar: ${result.recoveredFromSidecar.join(", ")}`,
        );
        await this.loadProfiles();
      }
      const warning = formatOrphanedSubAgentWarning(result.stillOrphaned);
      if (warning) {
        console.warn(warning);
      }
    } catch (error) {
      console.warn(
        "[SubAgentService] Sub-agent integrity reconcile skipped:",
        (error as Error).message.slice(0, 160),
      );
    }
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
        appIds: [STANDALONE_APP_ID],
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
    this.uploadCustomProfilesToCloud(new Date().toISOString());
  }

  private async ensureDefaultProfiles(): Promise<void> {
    const now = new Date().toISOString();
    let changed = false;
    for (const base of DEFAULT_SUB_AGENTS) {
      const existing = this.profiles.get(base.id);
      if (!existing) {
        this.profiles.set(base.id, {
          ...base,
          createdAt: now,
          updatedAt: now,
          runCount: 0,
        });
        changed = true;
        continue;
      }

      // Keep all built-in profiles in sync (prompt, tools, maxTurns, models)
      if (BUILTIN_SUB_AGENT_ID_SET.has(base.id)) {
        const synced: SubAgentProfile = {
          ...existing,
          name: base.name,
          description: base.description,
          systemPrompt: base.systemPrompt,
          provider: base.provider,
          model: base.model,
          fallbackProvider: base.fallbackProvider,
          fallbackModel: base.fallbackModel,
          allowedToolIds: base.allowedToolIds,
          assignedSkills: base.assignedSkills,
          outputMode: base.outputMode,
          maxTurns: base.maxTurns,
          memoryPolicy: base.memoryPolicy,
          icon: base.icon,
          updatedAt: now,
        };
        if (JSON.stringify(synced) !== JSON.stringify(existing)) {
          this.profiles.set(base.id, synced);
          changed = true;
        }
      }
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
    const direct = this.profiles.get(agentId);
    if (direct) return direct;
    const { profile } = resolveSubAgentProfile(
      Array.from(this.profiles.values()),
      agentId,
    );
    return profile;
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
      fallbackProvider: input.fallbackProvider ?? existing?.fallbackProvider,
      fallbackModel: input.fallbackModel ?? existing?.fallbackModel,
      allowedToolIds: input.allowedToolIds,
      assignedSkills: input.assignedSkills ?? existing?.assignedSkills ?? [],
      outputMode: input.outputMode ?? existing?.outputMode ?? "natural",
      outputSchema: input.outputSchema ?? existing?.outputSchema,
      maxTurns: input.maxTurns ?? existing?.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
      memoryPolicy: input.memoryPolicy ?? existing?.memoryPolicy ?? "none",
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

  async deleteAgent(agentId: string, options?: { force?: boolean }): Promise<boolean> {
    await this.initialize();
    if (BUILTIN_SUB_AGENT_ID_SET.has(agentId)) {
      throw new Error(`Cannot delete built-in sub-agent: ${agentId}`);
    }
    const refs = collectSubAgentReferences(getPaprRoot(), agentId);
    if (refs.length > 0 && !options?.force) {
      const summary = refs.map((r) => `${r.kind} "${r.label}" (${r.id})`).join("; ");
      throw new Error(
        `Cannot delete sub-agent ${agentId} — still referenced by ${summary}. ` +
          "Disable app agent chat or update jobs first, or pass force: true.",
      );
    }
    const deleted = this.profiles.delete(agentId);
    if (deleted) {
      await this.saveProfiles();
    }
    return deleted;
  }

  async listOrphanedReferences(): Promise<
    ReturnType<typeof findOrphanedSubAgentReferences>
  > {
    await this.initialize();
    return findOrphanedSubAgentReferences(
      getPaprRoot(),
      Array.from(this.profiles.values()),
    );
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

  /** Delegations initiated from a specific main chat (for pinned report cards in UI). */
  async listRunsForChat(
    reportChatId: string,
    limit = 20,
  ): Promise<DelegationRunRecord[]> {
    const trimmed = reportChatId.trim();
    if (!trimmed) return [];
    const runs = await this.listRuns(200);
    return runs
      .filter((run) => run.reportChatId === trimmed)
      .slice(0, limit);
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

  async delegateTask(input: DelegateTaskInput): Promise<DelegationRunRecord> {
    await this.initialize();
    const profiles = await this.listAgents();
    const { profile: selected, error } = resolveSubAgentProfile(
      profiles,
      input.useAgentId,
    );
    if (!selected) {
      throw new Error(error ?? "Sub-agent not found");
    }

    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.createJob({
      name: `Delegation: ${selected.name}`,
      type: "subagent",
      appIds:
        input.appIds && input.appIds.length > 0
          ? input.appIds
          : [STANDALONE_APP_ID],
      subAgentId: selected.id,
      delegatedBy: input.delegatedBy ?? "main-agent",
      delegationTask: input.task,
      delegationContext: input.context,
      command: input.task,
      outputMode: input.outputMode ?? selected.outputMode ?? "natural",
      outputSchema: input.outputSchema ?? selected.outputSchema,
      maxTurns: input.maxTurns ?? selected.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
      memoryPolicy: input.memoryPolicy ?? selected.memoryPolicy ?? "none",
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
    const { getCurrentDelegationJobId } =
      await import("../../core/tools/context.js");
    const delegationId = getCurrentDelegationJobId();
    if (!delegationId) {
      throw new Error(
        "complete_delegation requires sub-agent delegation context (delegationJobId not set)",
      );
    }

    console.log(
      `[SubAgentService] Completing delegation ${delegationId} (${result.length} chars)`,
    );

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
      // Ignore — use defaults below
    }

    const timestamp = new Date().toISOString();
    const content = summary ? `${summary}\n\n${result}` : result;
    const chatMessage = {
      role: "assistant" as const,
      author: "sub-agent" as const,
      content,
      timestamp,
    };

    await this.saveToDelegationChat(delegationId, {
      id: `msg-${uuidv4()}`,
      role: "assistant",
      content,
      timestamp,
      source_agent_id: sourceAgentId,
      source_agent_name: sourceAgentName,
    });

    const { broadcast } = await import("../websocket/index.js");
    broadcast({
      type: "subagent-chat:message",
      data: { delegationId, message: chatMessage },
    });
    broadcast({
      type: "subagent-chat:completed",
      data: {
        delegationId,
        jobId: delegationId,
        result,
        summary,
        timestamp,
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

/** Reset singleton after org/namespace workspace switch. */
export function resetSubAgentServiceForWorkspaceSwitch(): void {
  subAgentServiceInstance = null;
}
