import type { Provider } from "./agents.js";

/** Predefined icon names for sub-agents (sidebar-style SVGs) */
export type SubAgentIconName =
  | "robot"
  | "search"
  | "code"
  | "pen"
  | "chart";

/**
 * How a sub-agent run is assembled. Every field is optional and defaults to
 * the full Pen runtime, so existing profiles behave exactly as before.
 */
export interface SubAgentRuntimeOptions {
  /**
   * append (default): the profile prompt rides on top of Pen's full system
   * prompt. replace: the profile prompt IS the system prompt — no Pen
   * instructions, skills or platform docs. A blank prompt in replace mode
   * becomes a one-line neutral assistant prompt.
   */
  systemPromptMode?: "append" | "replace";
  /** Papr memory catalog, goals and use cases in context. Default true. */
  memoryContext?: boolean;
  /** Local wiki graph catalog in context. Default true. */
  wikiContext?: boolean;
  /** Papr tools. false = no tools at all (allowedToolIds ignored). Default true. */
  tools?: boolean;
  /** Provider-native web search (ChatGPT/OpenAI web_search, Gemini Google Search). Default true. */
  nativeWebSearch?: boolean;
  /** Anthropic prompt caching (system 1h + conversation 5m; long retention on sign-in). Default true. */
  promptCaching?: boolean;
  /** Stale tool-result compaction and oldest-turn trimming. Default true. */
  contextTrimming?: boolean;
}

/** Resolved runtime options with every default filled in. */
export function resolveSubAgentRuntime(
  runtime?: SubAgentRuntimeOptions,
): Required<SubAgentRuntimeOptions> {
  return {
    systemPromptMode: runtime?.systemPromptMode ?? "append",
    memoryContext: runtime?.memoryContext ?? true,
    wikiContext: runtime?.wikiContext ?? true,
    tools: runtime?.tools ?? true,
    nativeWebSearch: runtime?.nativeWebSearch ?? true,
    promptCaching: runtime?.promptCaching ?? true,
    contextTrimming: runtime?.contextTrimming ?? true,
  };
}

/** Neutral system prompt used when replace mode is given a blank prompt. */
export const BLANK_SUBAGENT_SYSTEM_PROMPT = "You are a helpful assistant.";

export interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: Provider;
  model?: string;
  /** When primary provider auth is unavailable, try this model next */
  fallbackProvider?: Provider;
  fallbackModel?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
  /** Icon name for sidebar/mini-chat (robot, search, code, pen, chart) */
  icon?: SubAgentIconName;
  /** Runtime assembly: replace system prompt, memory/wiki/tools/search/caching switches. */
  runtime?: SubAgentRuntimeOptions;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
}

export type DelegationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface DelegationRunRecord {
  id: string;
  agentId: string;
  /** Display name of the sub-agent (e.g. "Research Specialist") */
  agentName?: string;
  /** Icon name for mini-chat (robot, search, code, pen, chart) */
  agentIcon?: SubAgentIconName;
  task: string;
  context?: string;
  status: DelegationRunStatus;
  reportChatId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  resultText?: string;
  error?: string;
}

export interface DelegateTaskInput {
  task: string;
  context?: string;
  /** Required — exact id from list_sub_agents() or create_sub_agent() return value */
  useAgentId: string;
  reportChatId?: string;
  background?: boolean;
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
  /** Mini-app ids for app-scoped tool context (embedded app agent chat). */
  appIds?: string[];
  delegatedBy?: "main-agent" | "app-user";
}

/**
 * Sub-agent chat session for multi-turn interaction
 * Enables main agent and user to communicate with sub-agent in real-time
 */
export interface SubAgentChatSession {
  delegationId: string; // Links to delegation run (job ID)
  chatId: string; // "subagent:{delegationId}"
  parentChatId: string; // Main chat where delegation was triggered
  subAgentId: string; // Which sub-agent profile is running
  participants: string[]; // ["main-agent", "sub-agent", ...user if joined]
  status: "active" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
}

/**
 * Message in a sub-agent chat session
 */
export interface SubAgentChatMessage {
  role: "user" | "assistant";
  author: "main-agent" | "sub-agent" | "user";
  content: string;
  timestamp: string;
  chatId: string; // "subagent:{delegationId}"
}
