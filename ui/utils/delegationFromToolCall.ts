/**
 * Delegation UI expects delegate_task tool calls. With tool deferral (Enhancement 113),
 * the model often invokes delegate_task via run_deferred_tool — same payload, different name.
 */

import {
  parseDelegationFromToolResult,
  type DelegationData,
} from "../components/Chat/DelegationCard";

export type DelegationToolCallLike = {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  id?: string;
  status?: string;
};

export function isDelegateTaskInvocation(
  toolName: string,
  args?: Record<string, unknown>,
): boolean {
  if (toolName === "delegate_task") {
    return true;
  }
  if (toolName === "run_deferred_tool") {
    return args?.tool_name === "delegate_task";
  }
  return false;
}

/** Args as passed to delegate_task (unwraps run_deferred_tool.arguments). */
export function delegateTaskArgsFromToolCall(
  toolName: string,
  args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!args) {
    return undefined;
  }
  if (toolName === "run_deferred_tool" && args.tool_name === "delegate_task") {
    const inner = args.arguments;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    return {};
  }
  if (toolName === "delegate_task") {
    return args;
  }
  return undefined;
}

export function parseDelegationFromToolCall(
  toolName: string,
  result: unknown,
): DelegationData | null {
  if (toolName === "delegate_task") {
    return parseDelegationFromToolResult("delegate_task", result);
  }
  if (toolName === "run_deferred_tool") {
    return parseDelegationFromToolResult("delegate_task", result);
  }
  return null;
}

export function buildDelegationDataWhileRunning(
  toolCall: DelegationToolCallLike,
  resolveAgentDisplay: (useAgentId?: string) => {
    agentId: string;
    agentName?: string;
  },
): DelegationData | null {
  if (!isDelegateTaskInvocation(toolCall.toolName, toolCall.args)) {
    return null;
  }
  const args = delegateTaskArgsFromToolCall(toolCall.toolName, toolCall.args);
  const { agentId, agentName } = resolveAgentDisplay(
    args?.useAgentId as string | undefined,
  );
  return {
    id: toolCall.id ?? `delegation-${Date.now()}`,
    agentId,
    agentName,
    task: (args?.task as string) ?? "Delegated task",
    context: args?.context as string | undefined,
    status: "running",
  };
}
