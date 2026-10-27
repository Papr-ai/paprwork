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
  /** Builders: the plan this seat is on (may differ from the org's default plan). */
  plan?: string;
  /** Downgraded this period: keeps this plan's credits until renewal. */
  planUntilPeriodEnd?: string;
}

export interface SeatPlanOption {
  key: string;
  name: string;
  price: number;
  credits: number;
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
  /** {plan: seats on it}. */
  seatPlans?: Record<string, number>;
  planOptions?: SeatPlanOption[];
}

/** What a person's seat is: "member" or a plan key. */
export function seatValue(view: BuildersView | null, row: BuilderUsageRow | undefined, builder: boolean): string {
  if (!builder) return "member";
  return row?.plan ?? view?.plan ?? "member";
}

/** Monthly seat total across plans. */
export function monthlySeatTotal(view: BuildersView | null): number {
  if (!view) return 0;
  const price = new Map((view.planOptions ?? []).map((o) => [o.key, o.price]));
  const counts = view.seatPlans ?? (view.plan ? { [view.plan]: view.seats } : {});
  return Object.entries(counts).reduce((sum, [k, n]) => sum + (price.get(k) ?? 0) * n, 0);
}

/** Confirm text for changing a seat from `from` to `to` ("member" or a plan key). */
/** "member" in the seat menu = pay as you go (no seat). */
export const PAYG = "member";

export interface SeatChange {
  /** true = charged now (new seat or upgrade): needs an explicit confirm. false = nothing
   *  charged now (downgrade / pay as you go): applied after an undo window. */
  chargesNow: boolean;
  /** Monthly price difference ($), positive = more. */
  deltaPerMonth: number;
  /** One line for the inline confirm / undo toast. */
  summary: string;
}

/** What moving a seat from -> to does to the bill. Plan keys or PAYG. */
export function describeSeatChange(view: BuildersView, from: string, to: string): SeatChange {
  const opt = (k: string) => (view.planOptions ?? []).find((o) => o.key === k);
  const price = (k: string) => (k === PAYG ? 0 : opt(k)?.price ?? 0);
  const name = (k: string) => (k === PAYG ? "Pay as you go" : opt(k)?.name ?? k);
  const delta = price(to) - price(from);
  const cap = formatCredits(view.memberCap);
  if (to === PAYG) {
    return { chargesNow: false, deltaPerMonth: delta,
      summary: `Keeps ${name(from)} credits until renewal, then pays per credit (up to ${cap}/mo).` };
  }
  if (from === PAYG) {
    return { chargesNow: true, deltaPerMonth: delta,
      summary: `Adds a ${name(to)} seat: +$${delta}/mo, the rest of this period is charged now.` };
  }
  if (delta > 0) {
    return { chargesNow: true, deltaPerMonth: delta,
      summary: `+$${delta}/mo. The difference for the rest of this period is charged now; credits apply right away.` };
  }
  return { chargesNow: false, deltaPerMonth: delta,
    summary: `−$${-delta}/mo from renewal. Keeps ${name(from)} credits until then.` };
}

/** Short plan label for menus: "Max 20x · $300". */
export function planLabel(view: BuildersView | null, key: string): string {
  if (key === PAYG) return "Pay as you go";
  const o = (view?.planOptions ?? []).find((x) => x.key === key);
  return o ? `${o.name.replace(/^Cloud /, "")} · $${o.price}` : key;
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

export type SetBuilderResult = {
  builder?: boolean;
  when?: "now" | "period_end";
  seats?: { builders?: number; changed?: boolean; error?: string };
};

/** builder=false -> member. builder=true with plan -> that seat on that plan (new or existing builder). */
export async function setBuilder(
  baseUrl: string,
  sessionToken: string,
  userId: string,
  builder: boolean,
  fetchImpl?: typeof fetch,
  plan?: string,
): Promise<SetBuilderResult> {
  if (!/^[A-Za-z0-9]{1,40}$/.test(userId)) throw new Error("Invalid user id");
  if (plan !== undefined && (!builder || !/^[a-z_]{1,32}$/.test(plan))) throw new Error("Invalid plan");
  const body = plan ? { builder, plan } : { builder };
  return (await credits(baseUrl, sessionToken, `/builders/${userId}`, { method: "POST", body }, fetchImpl)) as SetBuilderResult;
}
