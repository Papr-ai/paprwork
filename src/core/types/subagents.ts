import type { Provider } from "./agents.js";

/** Predefined icon names for sub-agents (sidebar-style SVGs) */
export type SubAgentIconName =
  | "robot"
  | "search"
  | "code"
  | "pen"
  | "chart";

export interface SubAgentProfile {
  id: string;
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
  /** Icon name for sidebar/mini-chat (robot, search, code, pen, chart) */
  icon?: SubAgentIconName;
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
  useAgentId?: string;
  reportChatId?: string;
  background?: boolean;
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
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
