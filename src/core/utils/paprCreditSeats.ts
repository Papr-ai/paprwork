/**
 * Builder seats (credits billing) — memory server /v1/credits/builders.
 *
 * A builder is a paid seat with its own monthly credits; a member builds too but has no
 * included credits and pays per credit (capped). Owners/admins are builders through their
 * role; members are promoted with the `expert` role. One Stripe bill per org (owner pays).
 */

export interface BuilderUsageRow {
  userId: string;
  roles: string[];
  seat: boolean;
  grant: number;
  used: number;
  state: string;
  overageCredits: number;
  overageUsd: number;
  memberCap?: number;
}

export interface BuildersView {
  organizationId: string;
  period: string;
  plan: string | null;
  pendingPlan?: { plan: string; at: number } | null;
  seats: number;
  stripeSeats: number | null;
  seatsInSync: boolean;
  creditsPerBuilder: number;
  memberCap: number;
  builderUsage: BuilderUsageRow[];
  members: string[];
  memberUsage: BuilderUsageRow[];
}

const BUILDER_ROLES = new Set(["owner", "admin", "moderator", "expert"]);

/** Builder through their role (owner/admin/moderator): can't be switched off here. */
export function isRoleBuilder(roles: readonly string[]): boolean {
  return roles.some((r) => r === "owner" || r === "admin" || r === "moderator");
}

export function isBuilderRoles(roles: readonly string[]): boolean {
  return roles.some((r) => BUILDER_ROLES.has(r));
}

/** userId -> usage row, builders and members merged (for the Team list). */
export function usageByUser(view: BuildersView | null): Map<string, BuilderUsageRow> {
  const out = new Map<string, BuilderUsageRow>();
  for (const row of [...(view?.memberUsage ?? []), ...(view?.builderUsage ?? [])]) {
    out.set(row.userId, row);
  }
  return out;
}

/** "12.4K / 150K credits" style label. */
export function formatCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 ? 1 : 0)}K`;
  return `${Math.round(n)}`;
}

async function credits(
  baseUrl: string,
  sessionToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl}/v1/credits${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

export async function fetchBuilders(
  baseUrl: string,
  sessionToken: string,
  fetchImpl?: typeof fetch,
): Promise<BuildersView> {
  return (await credits(baseUrl, sessionToken, "/builders", {}, fetchImpl)) as BuildersView;
}

export async function setBuilder(
  baseUrl: string,
  sessionToken: string,
  userId: string,
  builder: boolean,
  fetchImpl?: typeof fetch,
): Promise<{ builder: boolean; seats?: { builders?: number; changed?: boolean; error?: string } }> {
  if (!/^[A-Za-z0-9]{1,40}$/.test(userId)) throw new Error("Invalid user id");
  return (await credits(
    baseUrl,
    sessionToken,
    `/builders/${userId}`,
    { method: "POST", body: { builder } },
    fetchImpl,
  )) as { builder: boolean; seats?: { builders?: number; changed?: boolean; error?: string } };
}
