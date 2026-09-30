/**
 * Context inspector payload types — kept separate from the modal so lightweight
 * callers (context meter, segment detail) do not import the full inspector UI.
 */

export interface ContextSection {
  tokens: number;
  content?: string;
  count?: number;
  note?: string;
  [key: string]: unknown;
}

export interface ContextBreakdown {
  systemPrompt: ContextSection;
  conversationSummary: ContextSection | null;
  memoryBootstrap?: ContextSection & {
    wouldRunOnNextTurn: boolean;
    deferredBootstrap?: boolean;
    goalsOkrs: { tokens: number; content: string } | null;
    useCases: { tokens: number; content: string } | null;
    syncTiers: { tokens: number; content: string } | null;
    relatedMemory: { tokens: number; content: string } | null;
  };
  messages: ContextSection & {
    breakdown: Array<{ role: string; tokens: number; preview: string }>;
  };
  tools: ContextSection & {
    schemas: Array<{ id: string; description: string; parameters: unknown }>;
  };
  workspaceFiles: ContextSection & {
    files: Array<{ name: string; content: string; size: number }>;
  };
  skills: ContextSection & {
    skills: Array<{ id: string; name: string; description: string }>;
  };
  plans: ContextSection & {
    plans: Array<{
      planId: string;
      title: string;
      steps: Array<{ id: string; description: string; status: string }>;
    }>;
  };
  focusContext?: ContextSection & {
    content: string;
    resolved: {
      activeApp?: { appId: string; title: string; files?: string[] };
      activeJob?: { jobId: string; name: string; files?: string[] };
      lastEdited?: Array<{
        kind: string;
        path: string;
        appId?: string;
        jobId?: string;
        repoRoot?: string;
        filename?: string;
        editedAt: string;
      }>;
    } | null;
  };
  paprSync?: ContextSection & {
    storageMode: string;
    syncEnabled: boolean;
    paprConfigured: boolean;
    paprUserId: string | null;
    hasLocalSummary: boolean;
    conversationSummaryInContext: boolean;
    memoryBootstrapOnNextTurn: boolean;
    messageCounts: {
      total: number;
      synced: number;
      sync_pending: number;
      sync_failed: number;
      local: number;
      papr_only: number;
    };
    recentSyncFailures: Array<{
      messageId: string;
      error: string;
      timestamp: string;
    }>;
  };
}

export interface ContextInfo {
  model: string;
  totalTokens: number;
  breakdown: ContextBreakdown;
}

export function isContextInfo(data: unknown): data is ContextInfo {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    typeof record.model === "string" &&
    typeof record.totalTokens === "number" &&
    typeof record.breakdown === "object" &&
    record.breakdown !== null
  );
}
