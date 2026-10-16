/**
 * Backend action access rules (manifest `acl`) and the host-bound `:caller_id`.
 *
 *   "public"   anyone who can open the app (default when omitted — today's behavior)
 *   "members"  signed-in team members (workspace team / named people / publisher)
 *   "caller"   any signed-in user; SQL scopes rows with :caller_id
 *   ["uid",…]  only these user ids
 *
 * `:caller_id` is filled by the host from the verified sign-in. Handlers never
 * pass it: the proxy splices the value into the bound args at the parameter's
 * position, so whatever the handler sends cannot replace it.
 */

import type { AppAccessContext } from "./types.js";
import { stripLiteralsAndComments } from "./engineOwnedTables.js";

export type ActionAcl = "public" | "members" | "caller" | string[];

const NAMED: ReadonlySet<string> = new Set(["public", "members", "caller"]);
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEAM_MODES = new Set(["owner", "team", "people"]);

export function parseActionAcl(actionName: string, raw: unknown): ActionAcl | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && NAMED.has(raw)) return raw as ActionAcl;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((u) => typeof u === "string" && USER_ID_RE.test(u))) {
    return [...new Set(raw as string[])];
  }
  throw new Error(
    `backend manifest: actions.${actionName}.acl must be "public", "members", "caller" or a list of user ids`,
  );
}

function deny(status: 401 | 403, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Throw 401/403 unless the verified caller may run an action with this acl. */
export function assertActionAclAllowed(
  actionName: string,
  acl: ActionAcl | undefined,
  access: Pick<AppAccessContext, "mode" | "userId">,
  callerUserId: string | undefined,
): void {
  const rule = acl ?? "public";
  if (rule === "public") return;
  const caller = callerUserId?.trim();
  if (!caller) throw deny(401, `Sign in to use "${actionName}".`);
  if (rule === "caller") return;
  if (caller === access.userId.trim()) return; // publisher
  if (rule === "members") {
    if (TEAM_MODES.has(access.mode)) return;
    throw deny(403, `"${actionName}" is for team members only.`);
  }
  if (rule.includes(caller)) return;
  throw deny(403, `You don't have access to "${actionName}".`);
}

/**
 * 1-based SQLite parameter index of every `:caller_id` (all occurrences share
 * one index). Follows SQLite's numbering: `?` = max+1, `?NNN` = NNN, a named
 * parameter takes max+1 on first use. Literals and comments are ignored.
 */
export function callerIdParamIndex(sql: string): number | null {
  return sqlParamLayout(sql).callerIndex;
}

/** SQLite parameter slots in `sql` and where `:caller_id` sits (null = absent). */
export function sqlParamLayout(sql: string): { callerIndex: number | null; slots: number } {
  const scrubbed = stripLiteralsAndComments(sql);
  const re = /\?(\d*)|[:@$]([A-Za-z_][A-Za-z0-9_]*)|"[^"]*"|`[^`]*`|\[[^\]]*\]/g;
  const named = new Map<string, number>();
  let max = 0;
  for (const m of scrubbed.matchAll(re)) {
    if (m[0].startsWith("?")) {
      max = m[1] ? Math.max(max, Number(m[1])) : max + 1;
    } else if (m[2] !== undefined) {
      const key = m[0];
      if (!named.has(key)) named.set(key, ++max);
    }
  }
  return { callerIndex: named.get(":caller_id") ?? null, slots: max };
}

/**
 * Bind the verified caller into `:caller_id`. SQL without it passes through.
 * Handlers that send an object of named args can't include caller_id either.
 */
export function bindCallerId(
  sql: string,
  params: unknown[] | Record<string, unknown> | undefined,
  callerUserId: string | undefined,
): unknown[] | Record<string, unknown> | undefined {
  const { callerIndex: index, slots } = sqlParamLayout(sql);
  if (index === null) return params;
  const caller = callerUserId?.trim();
  if (!caller) throw deny(401, "Sign in required: this query is scoped to the signed-in user (:caller_id).");
  if (params && !Array.isArray(params)) {
    const named = { ...params };
    for (const k of Object.keys(named)) if (k.replace(/^[:@$]/, "") === "caller_id") delete named[k];
    return { ...named, ":caller_id": caller };
  }
  const args = [...(params ?? [])];
  if (args.length > slots - 1) {
    throw Object.assign(
      new Error("Don't pass a value for :caller_id — the host fills it from the signed-in user. Pass only the other parameters."),
      { status: 400 },
    );
  }
  while (args.length < index - 1) args.push(null);
  args.splice(index - 1, 0, caller);
  return args;
}
