/**
 * v9 audiences access (memory PUT /v1/cloud/apps/{id}/access, accessModel=audiences).
 *
 * One path for everything that changes who can open a published app: the Share
 * sheet (via the gateway proxy) and agent tools (publish_cloud_app). Keeps local
 * publish prefs (link, token, icon) mirrored from the server's answer.
 */

import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getCloudAppLineageService } from "./CloudAppLineageService.js";
import { getAppPublishPrefs, setAppPublishPrefs, type CloudAccessMode } from "./cloudPublishPrefs.js";
import { blocksCommunityListing, COMMUNITY_NEEDS_GALLERY, type AccessStateLike } from "./communityGalleryGate.js";

export type AudienceRole = "none" | "viewer" | "contributor" | "maintainer" | "admin";

export interface AudiencesPatch {
  accessModel?: "audiences";
  workspaceRole?: AudienceRole;
  linkRole?: AudienceRole;
  communityRole?: AudienceRole;
  requireSignIn?: boolean;
  /** Largest visitor upload in MB (server default 50). */
  uploadMaxMb?: number;
  /** People by id, email, or whole email domain ({ domain: "acme.com" }), each with a role. */
  grants?: { userId?: string; email?: string; domain?: string; role: AudienceRole }[];
}

export interface AudiencesAccess extends AccessStateLike {
  accessModel?: string;
  visibility?: CloudAccessMode;
  linkPermission?: "read" | "read_write";
  requireSignIn?: boolean;
  audiences?: { workspace: boolean; link: boolean; community: boolean };
  workspaceRole?: AudienceRole;
  linkRole?: AudienceRole;
  communityRole?: AudienceRole;
  shareToken?: string;
  uploadMaxMb?: number;
}

/** Legacy publish_cloud_app sharing args, mapped onto audience roles like the Share sheet. */
export interface LegacySharingArgs {
  loginAccess?: "private" | "team" | "public" | "none";
  externalLink?: "off" | "read" | "read_write";
  requireSignIn?: boolean;
}

const on = (r?: AudienceRole) => !!r && r !== "none";

/** A team collaborator's copy manages the original app's access. */
export async function accessTargetAppId(appId: string): Promise<string> {
  const lineage = await getCloudAppLineageService().readLineageForApp(appId);
  return lineage?.mode === "track" && lineage.databasePolicy === "shared" ? lineage.sourceAppId : appId;
}

export async function fetchAudiences(appId: string): Promise<AudiencesAccess | null> {
  const target = await accessTargetAppId(appId);
  const res = await cloudApiFetch(`/v1/cloud/apps/${encodeURIComponent(target)}/access`, { method: "GET", timeoutMs: 20_000 });
  return res.ok ? ((await res.json().catch(() => null)) as AudiencesAccess | null) : null;
}

/**
 * Build the patch for legacy args. Mirrors the sheet's rules: the public row is
 * either "Anyone with the link" or "Listed in Community", never both; turning an
 * audience on keeps its current role when it already has one.
 */
export function audiencesPatchFromSharing(args: LegacySharingArgs, current: AudiencesAccess | null): AudiencesPatch {
  const p: AudiencesPatch = {};
  if (current?.accessModel !== "audiences") p.accessModel = "audiences";
  const keep = (r: AudienceRole | undefined, fallback: AudienceRole): AudienceRole => (on(r) ? r! : fallback);
  const open = current?.audiences;
  switch (args.loginAccess) {
    case "private":
    case "none":
      p.workspaceRole = "none";
      p.communityRole = "none";
      break;
    case "team":
      p.workspaceRole = keep(open?.workspace ? current?.workspaceRole : undefined, "viewer");
      p.communityRole = "none";
      break;
    case "public":
      p.communityRole = keep(open?.community ? current?.communityRole : undefined, "viewer");
      if (args.externalLink === undefined) p.linkRole = "none";
      break;
  }
  if (args.externalLink === "off") p.linkRole = "none";
  if (args.externalLink === "read") p.linkRole = "viewer";
  if (args.externalLink === "read_write") p.linkRole = "contributor";
  if (on(p.linkRole) && args.loginAccess !== "public") p.communityRole = "none";
  if (args.requireSignIn !== undefined) p.requireSignIn = args.requireSignIn;
  return p;
}

/**
 * The link audience's role decides read vs read+write, as in the Share sheet.
 * The server's legacy `linkPermission` / `visibility` can lag behind the role
 * (an old read_write link stays read_write after the role drops to viewer), so
 * they are only used when no role is reported.
 */
function linkWrites(a: AudiencesAccess): boolean {
  if (a.linkRole) return a.linkRole !== "none" && a.linkRole !== "viewer";
  return a.linkPermission === "read_write";
}

/** Legacy access mode derived from the audiences, so the publish bar and tool agree with the sheet. */
export function audiencesAccessMode(a: AudiencesAccess): CloudAccessMode | undefined {
  const open = a.audiences;
  if (!open) return a.visibility;
  if (open.link) return (linkWrites(a) ? "link_read_write" : "link_read") as CloudAccessMode;
  if (open.community) return "public_read" as CloudAccessMode;
  if (open.workspace) return "team" as CloudAccessMode;
  return "private" as CloudAccessMode;
}

/** Mirror the server's answer into local prefs so the bar's link, token and next publish agree. */
export function syncAudiencePrefs(appId: string, a: AudiencesAccess | null): void {
  if (!a || a.accessModel !== "audiences" || !a.audiences) return;
  const open = a.audiences;
  const prefs = getAppPublishPrefs(appId);
  setAppPublishPrefs(appId, {
    accessMode: audiencesAccessMode(a) ?? prefs.accessMode,
    loginAccess: open.community ? "public" : open.workspace ? "team" : "private",
    externalLink: open.link ? (linkWrites(a) ? "read_write" : "read") : "off",
    requireSignIn: a.requireSignIn === true,
    audiencesModel: true,
    ...(a.shareToken ? { shareToken: a.shareToken } : {}),
    // People are grants now; the old allowlists were folded in server-side.
    allowedUserIds: undefined,
    allowedEmails: undefined,
    allowedEmailDomains: undefined,
  });
}

export class AudiencesError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** PUT the patch (with the Community gallery gate), then mirror prefs. Returns the new access. */
export async function saveAudiences(
  appId: string,
  patch: AudiencesPatch,
  opts: { hasGallery?: boolean; current?: AudiencesAccess | null } = {},
): Promise<AudiencesAccess> {
  const target = await accessTargetAppId(appId);
  if (blocksCommunityListing(patch, opts.current ?? null, false) && !opts.hasGallery) {
    const current = opts.current !== undefined ? opts.current : await fetchAudiences(appId);
    if (blocksCommunityListing(patch, current, false)) {
      throw new AudiencesError(COMMUNITY_NEEDS_GALLERY, 409, "community_needs_gallery");
    }
  }
  const res = await cloudApiFetch(`/v1/cloud/apps/${encodeURIComponent(target)}/access`, {
    method: "PUT",
    body: patch,
    timeoutMs: 20_000,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `Access update failed (${res.status})`;
    try {
      const b = JSON.parse(text) as { detail?: unknown; error?: unknown };
      const m = b.detail ?? b.error;
      if (typeof m === "string" && m) msg = m;
    } catch { /* not JSON */ }
    throw new AudiencesError(msg, res.status);
  }
  const access = JSON.parse(text || "{}") as AudiencesAccess;
  if (target === appId) syncAudiencePrefs(appId, access);
  return access;
}

/** Short, agent-facing view of who can open the app. */
export function describeAudiences(a: AudiencesAccess | null): Record<string, unknown> | null {
  if (!a?.audiences) return null;
  const role = (k: "workspace" | "link" | "community", r?: AudienceRole) => (a.audiences![k] ? r ?? "viewer" : "none");
  return {
    workspace: role("workspace", a.workspaceRole),
    link: role("link", a.linkRole),
    community: role("community", a.communityRole),
    requireSignIn: a.requireSignIn === true,
    ...(a.uploadMaxMb !== undefined ? { uploadMaxMb: a.uploadMaxMb } : {}),
  };
}
