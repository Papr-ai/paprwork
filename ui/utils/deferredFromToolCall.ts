/**
 * Enhancement 113: tools invoked via run_deferred_tool use the same args shape
 * as a direct call — { tool_name, arguments } — with the real payload nested.
 */

export type DeferredToolCallLike = {
  toolName?: string;
  args?: Record<string, unknown>;
};

export function deferredInnerToolName(
  toolName: string,
  args?: Record<string, unknown>,
): string | undefined {
  if (toolName !== "run_deferred_tool" || !args) {
    return undefined;
  }
  const inner = args.tool_name;
  return typeof inner === "string" && inner.length > 0 ? inner : undefined;
}

export function deferredInnerToolArgs(
  toolName: string,
  args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (toolName !== "run_deferred_tool" || !args) {
    return undefined;
  }
  const inner = args.arguments;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return {};
}

/** Unwrap run_deferred_tool to the inner tool call for display and UI logic. */
export function unwrapDeferredToolCall(toolCall: DeferredToolCallLike): {
  toolName: string;
  args: Record<string, unknown> | undefined;
} {
  const toolName = toolCall.toolName ?? "tool";
  const innerName = deferredInnerToolName(toolName, toolCall.args);
  if (!innerName) {
    return { toolName, args: toolCall.args };
  }
  return {
    toolName: innerName,
    args: deferredInnerToolArgs(toolName, toolCall.args),
  };
}
