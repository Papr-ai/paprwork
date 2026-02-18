import type { Provider } from "./agents.js";

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
