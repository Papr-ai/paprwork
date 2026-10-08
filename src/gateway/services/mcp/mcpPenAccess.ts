/**
 * Pen access: how much Pen may do with one connected service.
 *
 *   read  — tools marked read-only run; anything else is refused.
 *   ask   — read-only tools run; anything else asks the user first.
 *   full  — everything runs, except tools marked destructive, which still ask.
 *
 * A tool counts as read-only only when the server says so (annotations.readOnlyHint).
 * No flag means "might change something", so Pen asks rather than acts.
 *
 * The level is the lower of the key's own setting and the org's maxPenAccess.
 * Keys saved before this existed have no level and behave as "ask".
 */

export type PenAccess = "read" | "ask" | "full";
export type PenDecision = "allow" | "ask" | "deny";

const RANK: Record<PenAccess, number> = { read: 0, ask: 1, full: 2 };
export const DEFAULT_PEN_ACCESS: PenAccess = "ask";

export function normalizePenAccess(v: unknown): PenAccess | undefined {
  return v === "read" || v === "ask" || v === "full" ? v : undefined;
}

/** The key's level, never above the org's maximum. */
export function effectivePenAccess(keyLevel: unknown, orgMax: unknown): PenAccess {
  const own = normalizePenAccess(keyLevel) ?? DEFAULT_PEN_ACCESS;
  const max = normalizePenAccess(orgMax) ?? "full";
  return RANK[own] <= RANK[max] ? own : max;
}

export function decidePenAccess(
  level: PenAccess,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
): PenDecision {
  if (annotations?.readOnlyHint === true) return "allow";
  if (level === "read") return "deny";
  if (level === "full" && annotations?.destructiveHint !== true) return "allow";
  return "ask";
}

export class PenAccessDeniedError extends Error {
  readonly status = 403;
  readonly code = "pen_access";
  constructor(server: string, tool: string, why: "read_only" | "declined") {
    super(
      why === "read_only"
        ? `${server} is set to Read only, so Pen can't run "${tool}" (it may change something). Change it in Settings → Connections.`
        : `You declined "${tool}" on ${server}.`,
    );
  }
}
