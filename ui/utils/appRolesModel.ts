/**
 * App roles (GitHub-style) for the share sheet's "Who has access" panel.
 * Pure logic so the panel and tests read one source.
 * Server: memory GET/PUT /v1/cloud/apps/{id}/access (Admins only for PUT).
 * Plan: docs/APP_ROLES_AND_SHARING_PLAN.md §1, §2, §8.
 */

export type AppRole = "none" | "viewer" | "contributor" | "maintainer" | "admin";
export type ApprovalRule = "contributors" | "everyone";
export type AccessVisibility =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export interface AccessGrant {
  userId?: string;
  email?: string;
  role: AppRole;
}

export interface AppAccess {
  appId: string;
  visibility: AccessVisibility;
  linkPermission: "read" | "read_write";
  requireSignIn: boolean;
  publisherUserId: string;
  grants: AccessGrant[];
  workspaceRole: AppRole;
  linkRole: AppRole;
  communityRole: AppRole;
  approvalRule: ApprovalRule;
  /** True when the server worked these out from older share settings. */
  derived: boolean;
  admins: string[];
  callerRole: AppRole;
  canManage: boolean;
  /** Only on the PUT that first made an invite link. */
  shareToken?: string;
}

export type AccessPatch = Partial<
  Pick<
    AppAccess,
    | "grants"
    | "workspaceRole"
    | "linkRole"
    | "communityRole"
    | "approvalRule"
    | "visibility"
    | "requireSignIn"
  >
>;

const ORDER: AppRole[] = ["none", "viewer", "contributor", "maintainer", "admin"];

export const ROLE_COPY: Record<AppRole, { label: string; sub: string }> = {
  none: { label: "No access", sub: "Can't open it." },
  viewer: { label: "Viewer", sub: "Use the app" },
  contributor: { label: "Contributor", sub: "Copy the code and propose changes" },
  maintainer: { label: "Maintainer", sub: "Publish changes and approve proposals" },
  admin: { label: "Admin", sub: "Also manage access" },
};

/** Highest role each audience can be given (server enforces the same caps). */
export const AUDIENCE_CAP = {
  person: "admin",
  workspace: "maintainer",
  link: "contributor",
  community: "contributor",
} as const satisfies Record<string, AppRole>;

export type AccessAudience = keyof typeof AUDIENCE_CAP;

export function rank(role: AppRole | undefined | null): number {
  return Math.max(0, ORDER.indexOf((role ?? "none") as AppRole));
}

/** Choices for an audience's dropdown, lowest first. People never offer "none". */
export function roleOptions(audience: AccessAudience): AppRole[] {
  const cap = rank(AUDIENCE_CAP[audience]);
  return ORDER.filter((r, i) => i <= cap && !(audience === "person" && r === "none"));
}

export function grantKey(g: AccessGrant): string {
  return g.userId || (g.email ?? "").toLowerCase();
}

export function setGrantRole(
  grants: AccessGrant[],
  key: string,
  role: AppRole,
): AccessGrant[] {
  return grants.map((g) => (grantKey(g) === key ? { ...g, role } : g));
}

export function removeGrant(grants: AccessGrant[], key: string): AccessGrant[] {
  return grants.filter((g) => grantKey(g) !== key);
}

/** Adds a person once (default Contributor); a repeat add is a no-op. */
export function addGrant(
  grants: AccessGrant[],
  person: { userId?: string; email?: string },
  role: AppRole = "contributor",
): AccessGrant[] {
  const next: AccessGrant = {
    ...(person.userId ? { userId: person.userId } : {}),
    ...(person.email ? { email: person.email.toLowerCase() } : {}),
    role,
  };
  const key = grantKey(next);
  if (!key || grants.some((g) => grantKey(g) === key)) return grants;
  return [...grants, next];
}

/** Grants without the publisher (always Admin, shown as a fixed row). */
export function editableGrants(access: AppAccess): AccessGrant[] {
  return access.grants.filter((g) => g.userId !== access.publisherUserId);
}

export function isLinkVisibility(v: AccessVisibility): boolean {
  return v === "link_read" || v === "link_read_write";
}

/** "Workspace: Contributor · 2 people · Link: Viewer" */
export function summarizeAccess(a: Pick<AppAccess, "visibility" | "workspaceRole" | "linkRole" | "communityRole" | "grants" | "publisherUserId">): string {
  const parts: string[] = [];
  if (a.visibility === "team" && rank(a.workspaceRole) > 0) {
    parts.push(`Workspace: ${ROLE_COPY[a.workspaceRole].label}`);
  }
  const people = a.grants.filter((g) => g.userId !== a.publisherUserId).length;
  if (people > 0) parts.push(`${people} ${people === 1 ? "person" : "people"}`);
  if (isLinkVisibility(a.visibility) && rank(a.linkRole) > 0) {
    parts.push(`Link: ${ROLE_COPY[a.linkRole].label}`);
  }
  if (a.visibility === "public_read" && rank(a.communityRole) > 0) {
    parts.push(`Community: ${ROLE_COPY[a.communityRole].label}`);
  }
  return parts.length ? parts.join(" · ") : "Only Admins";
}

/** Only the fields that differ, so a save never rewrites what didn't change. */
export function accessPatch(live: AppAccess, draft: AppAccess): AccessPatch {
  const patch: AccessPatch = {};
  const keys = ["workspaceRole", "linkRole", "communityRole", "approvalRule", "visibility", "requireSignIn"] as const;
  for (const k of keys) {
    if (live[k] !== draft[k]) (patch as Record<string, unknown>)[k] = draft[k];
  }
  const norm = (g: AccessGrant[]) =>
    JSON.stringify([...g].map((x) => [grantKey(x), x.role]).sort());
  if (norm(live.grants) !== norm(draft.grants)) patch.grants = draft.grants;
  return patch;
}
