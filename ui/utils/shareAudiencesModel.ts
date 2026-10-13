/**
 * v9 Share sheet model: one row per audience, the role dropdown is the switch
 * ("No access" = off). Server: memory PUT /access with accessModel=audiences.
 * Pure logic; ShareWhoV9 renders it.
 */

import {
  ROLE_COPY,
  grantKey,
  rank,
  type AccessGrant,
  type AccessPatch,
  type AppAccess,
  type AppRole,
} from "./appRolesModel";
import type { ShareAudience } from "./shareAudienceModel";

export type AudienceKey = "workspace" | "link" | "community";
export const AUDIENCE_KEYS: AudienceKey[] = ["workspace", "link", "community"];

export interface AudiencesDraft {
  workspace: AppRole;
  link: AppRole;
  community: AppRole;
  grants: AccessGrant[];
  requireSignIn: boolean;
}

/** The server can open several audiences at once (memory #228 deployed). */
export function supportsAudiences(a: AppAccess | null | undefined): a is AppAccess {
  return !!a?.audiences;
}

/**
 * What the sheet shows. Only audiences that can open the app today count as
 * on, so a leftover role (e.g. an old Community role on a Workspace app) never
 * appears switched on.
 */
export function draftFromAccess(a: AppAccess): AudiencesDraft {
  const open = a.audiences ?? { workspace: false, link: false, community: false };
  const role = (k: AudienceKey, r: AppRole): AppRole =>
    open[k] ? (rank(r) > 0 ? r : "viewer") : "none";
  return {
    workspace: role("workspace", a.workspaceRole),
    link: role("link", a.linkRole),
    community: role("community", a.communityRole),
    grants: a.grants,
    requireSignIn: a.requireSignIn,
  };
}

const normGrants = (g: AccessGrant[]) =>
  JSON.stringify([...g].map((x) => [grantKey(x), x.role]).sort());

export function audiencesDirty(live: AppAccess, d: AudiencesDraft): boolean {
  const base = draftFromAccess(live);
  return (
    AUDIENCE_KEYS.some((k) => base[k] !== d[k]) ||
    base.requireSignIn !== d.requireSignIn ||
    normGrants(base.grants) !== normGrants(d.grants)
  );
}

/**
 * The first v9 save sends everything plus the marker (from then on the roles
 * decide who can open it); later saves send only what changed.
 */
export function audiencesPatch(live: AppAccess, d: AudiencesDraft): AccessPatch {
  const first = live.accessModel !== "audiences";
  const base = draftFromAccess(live);
  const p: AccessPatch = first ? { accessModel: "audiences" } : {};
  if (first || base.workspace !== d.workspace) p.workspaceRole = d.workspace;
  if (first || base.link !== d.link) p.linkRole = d.link;
  if (first || base.community !== d.community) p.communityRole = d.community;
  if (first || base.requireSignIn !== d.requireSignIn) p.requireSignIn = d.requireSignIn;
  if (first || normGrants(base.grants) !== normGrants(d.grants)) p.grants = d.grants;
  return p;
}

export function peopleCount(d: Pick<AudiencesDraft, "grants">, publisherUserId: string): number {
  return d.grants.filter((g) => g.userId !== publisherUserId).length;
}

/** "Workspace: Contributor · 2 people · Link: Viewer" (prototype summaryLine). */
export function summarizeAudiences(d: AudiencesDraft, publisherUserId: string): string {
  const n = peopleCount(d, publisherUserId);
  return [
    rank(d.workspace) > 0 && `Workspace: ${ROLE_COPY[d.workspace].label}`,
    n > 0 && `${n} ${n === 1 ? "person" : "people"}`,
    rank(d.link) > 0 && `Link: ${ROLE_COPY[d.link].label}`,
    rank(d.community) > 0 && `Community: ${ROLE_COPY[d.community].label}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Widest audience that's on, for the link icon and the data check. */
export function widestAudience(d: AudiencesDraft, publisherUserId: string): ShareAudience {
  if (rank(d.community) > 0) return "public";
  if (rank(d.link) > 0) return "link";
  if (rank(d.workspace) > 0) return "team";
  return peopleCount(d, publisherUserId) > 0 ? "people" : "private";
}

/** Sign-in is a choice only when Link or Community is on. */
export function signInChoice(d: AudiencesDraft): boolean {
  return rank(d.link) > 0 || rank(d.community) > 0;
}

/**
 * "Public access" is one row: off, Anyone with the link, or Listed in Community.
 * One role (Viewer or Contributor) follows the row when you switch between them.
 */
export type PublicMode = "off" | "link" | "community";

export function publicMode(d: Pick<AudiencesDraft, "link" | "community">): PublicMode {
  if (rank(d.community) > 0) return "community";
  return rank(d.link) > 0 ? "link" : "off";
}

export function publicRole(d: Pick<AudiencesDraft, "link" | "community">): AppRole {
  const m = publicMode(d);
  return m === "community" ? d.community : m === "link" ? d.link : "none";
}

/** Switch the public row; the role carries over (Viewer when turning it on). */
export function setPublicMode(d: AudiencesDraft, mode: PublicMode): AudiencesDraft {
  const cur = publicRole(d);
  const role = rank(cur) > 0 ? cur : "viewer";
  if (mode === "off") return { ...d, link: "none", community: "none" };
  if (mode === "community") return { ...d, link: "none", community: role };
  return { ...d, community: "none", link: role };
}

export function setPublicRole(d: AudiencesDraft, role: AppRole): AudiencesDraft {
  const m = publicMode(d);
  return m === "community" ? { ...d, community: role } : m === "link" ? { ...d, link: role } : d;
}
