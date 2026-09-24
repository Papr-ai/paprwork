/**
 * Share UI model: audience (who) + permission (what) → cloud ACL + code access prefs.
 */

export type ShareAudience = "private" | "team" | "people" | "public" | "link";
export type CloudLoginAccess = "private" | "team" | "public" | "none";
export type CloudExternalLink = "off" | "read" | "read_write";

/** read = view live app, write = use live app, edit = install/sync source in Paprwork */
export type SharePermission = "read" | "write" | "edit";
export type CodeAccess = "off" | "install";

export interface ShareAudienceModel {
  audience: ShareAudience;
  permission: SharePermission;
  /**
   * Link: true = Papr sign-in required (default), false = token-only.
   * Public Community: false = anonymous OK (default), true = sign-in required.
   */
  requireSignIn?: boolean;
  /** Separate Turso DB per signed-in user (registry DBs only). */
  perUserIsolation?: boolean;
  /**
   * audience "people": Parse _User.objectId values allowed to open the app.
   * Same identifier as externalUserId and list_namespace_users.externalUserId.
   *
   * "people" deliberately reuses the existing team ACL on the memory server
   * rather than introducing a new principal type, so no server-side ACL
   * migration is required. The consequence is that the memory server still
   * authorises *any* workspace member, and this list is what narrows it —
   * which is why it has to be enforced by the gateway on every request and
   * cannot be a client-side filter. See applyPeopleAllowlist in
   * gateway/services/appRuntime/miniAppAccess.ts.
   */
  allowedUserIds?: string[];
  /**
   * audience "people": any signed-in Papr user with this email (not necessarily
   * a workspace member). Matched case-insensitively against the session email.
   */
  allowedEmails?: string[];
  /**
   * audience "people": any signed-in user whose email is *@{domain}*.
   * Store without the leading @ (e.g. "client.com").
   */
  allowedEmailDomains?: string[];
}

export interface SharingToAudienceModelOptions {
  requireSignIn?: boolean;
  perUserIsolation?: boolean;
  allowedUserIds?: string[];
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** Normalize a single email for allowlist comparison. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

/** Drop invalid entries, trim, de-dupe (preserves order). */
export function normalizeAllowedEmails(
  emails: readonly string[] | undefined,
): string[] {
  if (!emails) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = typeof raw === "string" ? normalizeEmail(raw) : null;
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Normalize domain: lowercase, strip leading @, validate shape. */
export function normalizeEmailDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("@")) {
    domain = domain.slice(1);
  }
  if (!domain || !DOMAIN_PATTERN.test(domain)) {
    return null;
  }
  return domain;
}

export function normalizeAllowedEmailDomains(
  domains: readonly string[] | undefined,
): string[] {
  if (!domains) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    const domain = typeof raw === "string" ? normalizeEmailDomain(raw) : null;
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

export function emailDomainFromAddress(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  const at = normalized.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  return normalized.slice(at + 1);
}

/** True when any people allowlist field is non-empty. */
export function shareAudienceHasPeopleRestriction(
  model: Pick<
    ShareAudienceModel,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): boolean {
  return (
    normalizeAllowedUserIds(model.allowedUserIds).length > 0 ||
    normalizeAllowedEmails(model.allowedEmails).length > 0 ||
    normalizeAllowedEmailDomains(model.allowedEmailDomains).length > 0
  );
}

/**
 * External emails/domains require loginAccess "public" + requireSignIn on the
 * memory server — workspace "team" ACL cannot admit non-members.
 */
export function peopleAudienceUsesExternalGate(
  model: Pick<ShareAudienceModel, "allowedEmails" | "allowedEmailDomains">,
): boolean {
  return (
    normalizeAllowedEmails(model.allowedEmails).length > 0 ||
    normalizeAllowedEmailDomains(model.allowedEmailDomains).length > 0
  );
}

/** Drop blanks and duplicates, preserving the order the user picked. */
export function normalizeAllowedUserIds(ids: readonly string[] | undefined): string[] {
  if (!ids) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Whether a caller may open an app under this share model.
 *
 * Only constrains audience "people"; every other audience is already decided
 * by the cloud ACL. The publisher is always allowed, otherwise removing
 * yourself from your own allowlist would lock you out of your own app.
 */
export function isUserAllowedByAudienceModel(
  model: Pick<
    ShareAudienceModel,
    "audience" | "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
  callerUserId: string | undefined,
  publisherUserId?: string,
  callerEmail?: string,
): boolean {
  if (model.audience !== "people") {
    return true;
  }
  if (!shareAudienceHasPeopleRestriction(model)) {
    return true;
  }
  const caller = callerUserId?.trim();
  const email = callerEmail ? normalizeEmail(callerEmail) : null;
  if (!caller && !email) {
    return false;
  }
  const publisher = publisherUserId?.trim();
  if (publisher && caller && caller === publisher) {
    return true;
  }
  if (caller && normalizeAllowedUserIds(model.allowedUserIds).includes(caller)) {
    return true;
  }
  if (email && normalizeAllowedEmails(model.allowedEmails).includes(email)) {
    return true;
  }
  if (email) {
    const domain = emailDomainFromAddress(email);
    if (
      domain &&
      normalizeAllowedEmailDomains(model.allowedEmailDomains).includes(domain)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the share model requires Papr sign-in at the platform gate. */
export function audienceRequiresSignIn(model: ShareAudienceModel): boolean {
  if (
    model.audience === "team" ||
    model.audience === "people" ||
    model.audience === "private"
  ) {
    return true;
  }
  if (model.audience === "public") {
    return model.requireSignIn === true;
  }
  if (model.audience === "link") {
    return model.requireSignIn !== false;
  }
  return false;
}

export function permissionToCodeAccess(permission: SharePermission): CodeAccess {
  return permission === "edit" ? "install" : "off";
}

export function codeAccessToPermission(codeAccess: CodeAccess | undefined): SharePermission | null {
  return codeAccess === "install" ? "edit" : null;
}

export function sharingToAudienceModel(
  loginAccess: CloudLoginAccess,
  externalLink: CloudExternalLink,
  codeAccess: CodeAccess = "off",
  options?: SharingToAudienceModelOptions,
): ShareAudienceModel {
  const editPermission = codeAccessToPermission(codeAccess);
  if (editPermission) {
    if (loginAccess === "none" && externalLink !== "off") {
      return { audience: "link", permission: "edit", requireSignIn: false };
    }
    if (loginAccess === "public" && externalLink !== "off") {
      return { audience: "link", permission: "edit", requireSignIn: true };
    }
    if (loginAccess === "public") {
      return {
        audience: "public",
        permission: "edit",
        requireSignIn: options?.requireSignIn ?? false,
        ...(options?.perUserIsolation !== undefined
          ? { perUserIsolation: options.perUserIsolation }
          : {}),
      };
    }
    if (loginAccess === "team") {
      return teamAudienceFor("edit", options);
    }
    return { audience: "private", permission: "read" };
  }

  if (loginAccess === "none" && externalLink !== "off") {
    return {
      audience: "link",
      permission: externalLink === "read_write" ? "write" : "read",
      requireSignIn: false,
    };
  }
  if (loginAccess === "public" && externalLink !== "off") {
    return {
      audience: "link",
      permission: externalLink === "read_write" ? "write" : "read",
      requireSignIn: true,
    };
  }
  if (loginAccess === "public") {
    return {
      audience: "public",
      permission: "write",
      requireSignIn: options?.requireSignIn ?? false,
      ...(options?.perUserIsolation !== undefined
        ? { perUserIsolation: options.perUserIsolation }
        : {}),
    };
  }
  if (loginAccess === "team") {
    return teamAudienceFor("write", options);
  }
  return { audience: "private", permission: "read" };
}

/**
 * loginAccess "team" covers both "anyone in my workspace" and "specific
 * people" — the allowlist is what distinguishes them, so it decides here.
 */
function teamAudienceFor(
  permission: SharePermission,
  options?: SharingToAudienceModelOptions,
): ShareAudienceModel {
  const allowedUserIds = normalizeAllowedUserIds(options?.allowedUserIds);
  const allowedEmails = normalizeAllowedEmails(options?.allowedEmails);
  const allowedEmailDomains = normalizeAllowedEmailDomains(
    options?.allowedEmailDomains,
  );
  const hasRestriction =
    allowedUserIds.length > 0 ||
    allowedEmails.length > 0 ||
    allowedEmailDomains.length > 0;
  if (!hasRestriction) {
    return { audience: "team", permission };
  }
  const model: ShareAudienceModel = { audience: "people", permission };
  if (allowedUserIds.length > 0) {
    model.allowedUserIds = allowedUserIds;
  }
  if (allowedEmails.length > 0) {
    model.allowedEmails = allowedEmails;
  }
  if (allowedEmailDomains.length > 0) {
    model.allowedEmailDomains = allowedEmailDomains;
  }
  if (peopleAudienceUsesExternalGate(model)) {
    model.requireSignIn = true;
  }
  return model;
}

/**
 * Map stored publish prefs back to the share UI model. When any people
 * allowlist is present, prefer the "people" audience even if loginAccess is
 * "public" (external guests).
 */
export function publishPrefsToAudienceModel(
  loginAccess: CloudLoginAccess,
  externalLink: CloudExternalLink,
  codeAccess: CodeAccess = "off",
  options?: SharingToAudienceModelOptions,
): ShareAudienceModel {
  const allowedUserIds = normalizeAllowedUserIds(options?.allowedUserIds);
  const allowedEmails = normalizeAllowedEmails(options?.allowedEmails);
  const allowedEmailDomains = normalizeAllowedEmailDomains(
    options?.allowedEmailDomains,
  );
  if (
    allowedUserIds.length > 0 ||
    allowedEmails.length > 0 ||
    allowedEmailDomains.length > 0
  ) {
    const editPermission = codeAccessToPermission(codeAccess);
    if (editPermission) {
      if (loginAccess === "none" && externalLink !== "off") {
        return {
          audience: "link",
          permission: "edit",
          requireSignIn: false,
          allowedUserIds:
            allowedUserIds.length > 0 ? allowedUserIds : undefined,
          allowedEmails: allowedEmails.length > 0 ? allowedEmails : undefined,
          allowedEmailDomains:
            allowedEmailDomains.length > 0 ? allowedEmailDomains : undefined,
        };
      }
      return teamAudienceFor("edit", {
        ...options,
        allowedUserIds,
        allowedEmails,
        allowedEmailDomains,
      });
    }
    return teamAudienceFor("write", {
      ...options,
      allowedUserIds,
      allowedEmails,
      allowedEmailDomains,
    });
  }
  return sharingToAudienceModel(loginAccess, externalLink, codeAccess, options);
}

/** Live-app ACL only (code access stored separately in publish prefs). */
export function audienceModelToSharing(model: ShareAudienceModel): {
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
} {
  const permission =
    model.permission === "edit"
      ? resolveLivePermissionForEdit(model.audience)
      : model.permission;

  if (model.audience === "link") {
    const externalLink =
      model.permission === "edit" || permission === "write"
        ? "read_write"
        : "read";
    const requireSignIn = model.requireSignIn !== false;
    return {
      loginAccess: requireSignIn ? "public" : "none",
      externalLink,
    };
  }
  if (model.audience === "public") {
    return { loginAccess: "public", externalLink: "off" };
  }
  if (model.audience === "team") {
    return { loginAccess: "team", externalLink: "off" };
  }
  // Workspace members only → team ACL + gateway allowlist.
  // External emails/domains → public + sign-in (memory has no non-member principal).
  if (model.audience === "people") {
    if (peopleAudienceUsesExternalGate(model)) {
      return { loginAccess: "public", externalLink: "off" };
    }
    return { loginAccess: "team", externalLink: "off" };
  }
  return { loginAccess: "private", externalLink: "off" };
}

/** When sharing code, default live access by audience. */
export function resolveLivePermissionForEdit(
  audience: ShareAudience,
): Exclude<SharePermission, "edit"> {
  if (
    audience === "team" ||
    audience === "people" ||
    audience === "link" ||
    audience === "public"
  ) {
    return "write";
  }
  return "read";
}

/** Maps live-app permission to memory server linkPermission for publish ACL. */
export function liveLinkPermissionForAudienceModel(
  model: ShareAudienceModel,
): "read" | "read_write" {
  if (model.permission === "write") {
    return "read_write";
  }
  if (model.permission === "edit") {
    return resolveLivePermissionForEdit(model.audience) === "write"
      ? "read_write"
      : "read";
  }
  return "read";
}

export function audienceModelToPublishPrefs(model: ShareAudienceModel): {
  sharing: ReturnType<typeof audienceModelToSharing>;
  codeAccess: CodeAccess;
} {
  return {
    sharing: audienceModelToSharing(model),
    codeAccess: permissionToCodeAccess(model.permission),
  };
}

/** Live ACL changes only — code access uses PATCH prefs. */
export function permissionAffectsCloud(model: ShareAudienceModel): boolean {
  if (model.permission === "edit") {
    return model.audience !== "private";
  }
  if (
    model.audience === "private" ||
    model.audience === "team" ||
    model.audience === "people"
  ) {
    return model.permission === "read" || model.permission === "write";
  }
  return true;
}

export function isPermissionAvailable(
  audience: ShareAudience,
  permission: SharePermission,
): boolean {
  // Simplified UI: private, team, people, link (unlisted), public (Community)
  // Both "write" (view & interact) and "edit" (code) require non-private
  if (audience === "private") {
    // Private apps don't share permissions
    return false;
  }
  // For team, people, link, and public, both write and edit are available
  if (permission === "write" || permission === "edit") {
    return (
      audience === "link" ||
      audience === "team" ||
      audience === "people" ||
      audience === "public"
    );
  }
  // "read" is always available (though not in UI anymore)
  return true;
}

export function isWebLinkPermission(permission: SharePermission): boolean {
  return permission === "read" || permission === "write";
}

export function isCodePermission(permission: SharePermission): boolean {
  return permission === "edit";
}

/** Public published apps appear in Community catalog (metadata), regardless of code access. */
export function shouldListInCommunity(
  audience: ShareAudience,
  published: boolean,
): boolean {
  return published && audience === "public";
}

export function communityCodeInstallable(codeAccess: CodeAccess): boolean {
  return codeAccess === "install";
}
