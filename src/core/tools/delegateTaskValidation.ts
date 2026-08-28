import type { ZodError } from "zod";

/** Built-in id for app/job architecture briefs — copy verbatim into useAgentId. */
export const PRODUCT_ARCHITECT_DELEGATE_ID = "product-architect";

export const DELEGATE_TASK_EXAMPLE =
  'delegate_task({ useAgentId: "product-architect", task: "Product brief + architecture for: [goal]", context: "User constraints: ..." })';

const FORBIDDEN_DELEGATE_PARAM_KEYS = [
  "agentId",
  "subAgentId",
  "use_agent_id",
  "agent_id",
  "sub_agent_id",
] as const;

export function unwrapDelegateTaskRawInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return {};
  }
  const record = input as Record<string, unknown>;
  if (
    record.context &&
    typeof record.context === "object" &&
    !Array.isArray(record.context)
  ) {
    return record.context as Record<string, unknown>;
  }
  return record;
}

/**
 * Pre-schema validation: wrong param names or missing useAgentId — actionable retry text only (no aliasing).
 */
export function buildDelegateTaskValidationError(
  raw: Record<string, unknown>,
): string | null {
  for (const key of FORBIDDEN_DELEGATE_PARAM_KEYS) {
    if (key in raw) {
      return (
        `delegate_task rejected parameter "${key}". ` +
        `The only agent selector field is useAgentId (exact spelling). ` +
        `Retry: ${DELEGATE_TASK_EXAMPLE}. ` +
        `Call list_sub_agents() and copy the id field — not the display name.`
      );
    }
  }

  const useAgentId = raw.useAgentId;
  const hasUseAgentId =
    typeof useAgentId === "string" && useAgentId.trim().length > 0;

  if (!hasUseAgentId) {
    const hasTask = typeof raw.task === "string" && raw.task.trim().length > 0;
    if (hasTask || Object.keys(raw).length > 0) {
      return (
        "delegate_task missing required useAgentId. " +
        `Required shape: { useAgentId: "${PRODUCT_ARCHITECT_DELEGATE_ID}", task: string, context?: string }. ` +
        `For every new mini-app, use useAgentId: "${PRODUCT_ARCHITECT_DELEGATE_ID}" after list_sub_agents(). ` +
        `Do not use agentId, subAgentId, or agent display names.`
      );
    }
  }

  return null;
}

export function formatDelegateTaskZodError(error: ZodError): string {
  const unknownKey = error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknownKey && "keys" in unknownKey) {
    const keys = (unknownKey.keys as string[]).join(", ");
    return (
      `delegate_task received unknown parameter(s): ${keys}. ` +
      `Allowed: useAgentId, task, context, reportChatId, background, outputMode, outputSchema, maxTurns, memoryPolicy. ` +
      `Retry: ${DELEGATE_TASK_EXAMPLE}`
    );
  }

  const useAgentIdIssue = error.issues.find(
    (issue) => issue.path.join(".") === "useAgentId",
  );
  if (useAgentIdIssue) {
    return (
      `delegate_task useAgentId invalid or missing. ` +
      `Retry: ${DELEGATE_TASK_EXAMPLE}`
    );
  }

  return `delegate_task arguments invalid: ${error.issues.map((i) => i.message).join("; ")}. Retry: ${DELEGATE_TASK_EXAMPLE}`;
}
