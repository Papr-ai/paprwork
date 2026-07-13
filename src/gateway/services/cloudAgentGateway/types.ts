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
  prompt: string;
  paprApiKey: string;
  allowedToolIds?: string[];
  maxTurns?: number;
  repoCloneUrl: string;
  repoToken: string;
  repoBranch?: string;
  /** Linked mini-app sources from memory prepare (metadata). */
  linkedSources?: CloudLinkedSource[];
  /** Primary Turso short name for APP_DB routing. */
  primaryTursoShortName?: string;
  /** All Turso replicas to pull/push at run bookends (job scratch + APP_DB). */
  tursoSources?: CloudTursoSource[];
  /** @deprecated Prefer tursoSources — primary source Turso creds. */
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
}

export interface CloudAgentRunResponse {
  exitCode: number;
  output: string;
  error?: string;
  chatId: string;
}

export interface CloudProviderAuthResolution {
  provider: string;
  authType: "oauth" | "apiKey";
  token: string;
}
