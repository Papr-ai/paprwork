import type { Provider } from "../../../core/types/agents.js";

export interface CloudLinkedSource {
  alias: string;
  dbPath: string;
  tursoShortName: string;
  jobId?: string;
  dbId?: string;
  isolation?: "shared" | "per-user";
  role?: "primary" | "readonly" | "scratch";
}

export interface CloudTursoSource {
  /** Sync state key — job id or registry dbId. */
  syncKey: string;
  dbPath: string;
  databaseShortName: string;
  databaseUrl: string;
  authToken: string;
}

export interface CloudAgentRunRequest {
  orgId: string;
  namespaceId?: string;
  userId: string;
  jobId: string;
  runId: string;
  provider: string;
  model?: string;
  /** Per-run parameters from memory / mini-app (merged into prompt via AgentJobExecutor). */
  runtimeParams?: Record<string, string>;
  /** @deprecated Gateway builds prompt from cloned job via AgentJobExecutor — do not send from memory. */
  prompt?: string;
  paprApiKey: string;
  allowedToolIds?: string[];
  maxTurns?: number;
  repoCloneUrl: string;
  repoToken: string;
  repoBranch?: string;
  /** Linked mini-app sources from memory prepare (metadata). */
  linkedSources?: CloudLinkedSource[];
  /** @deprecated Prefer tursoSources from job writeDbIds + app linked sources. */
  primaryTursoShortName?: string;
  /** All Turso replicas to pull/push at run bookends (writeDbIds + linked registry DBs). */
  tursoSources?: CloudTursoSource[];
  /** @deprecated Prefer tursoSources — legacy single-source creds. */
  turso?: {
    jobId: string;
    /** Turso short name (j-{jobId8}, d-{dbId8}, or per-user suffix). */
    databaseShortName?: string;
    databaseUrl: string;
    authToken: string;
  };
  llmAuth: {
    authType: "oauth" | "apiKey";
    token: string;
    provider: string;
  };
  /** User vault keys from GCP Secret Manager (memory server) — injected into process.env for bash/run_job */
  vaultKeys?: Record<string, string>;
  /**
   * Stable id for workspace reuse (app-agent chat session).
   * When set, disk path uses /tmp/papr-cloud-session/{id}/ instead of per-runId.
   */
  workspaceSessionId?: string;
  /** After stream completes, keep cloned workspace on disk for follow-up turns. */
  keepWorkspaceWarm?: boolean;
}

export interface CloudAgentRunResponse {
  exitCode: number;
  output: string;
  error?: string;
  chatId: string;
}

export interface CloudProviderAuthResolution {
  provider: Provider;
  authType: "oauth" | "apiKey";
  token: string;
}

export interface CloudAgentSessionBeginResponse {
  status: "ready" | "warming";
  sessionId: string;
  expiresAt: string;
}

/** Idle TTL for warm gateway workspaces (matches AppAgentChatWarmCoordinator). */
export const CLOUD_AGENT_SESSION_TTL_MS = 15 * 60 * 1000;

/** Max warm sessions kept per gateway instance before LRU eviction. */
export const CLOUD_AGENT_SESSION_MAX_ENTRIES = 50;
