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
}

export interface SharingToAudienceModelOptions {
  requireSignIn?: boolean;
  perUserIsolation?: boolean;
  allowedUserIds?: string[];
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
  model: Pick<ShareAudienceModel, "audience" | "allowedUserIds">,
  callerUserId: string | undefined,
  publisherUserId?: string,
): boolean {
  if (model.audience !== "people") {
    return true;
  }
  const caller = callerUserId?.trim();
  if (!caller) {
    return false;
  }
  const publisher = publisherUserId?.trim();
  if (publisher && caller === publisher) {
    return true;
  }
  return normalizeAllowedUserIds(model.allowedUserIds).includes(caller);
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
  if (allowedUserIds.length > 0) {
    return { audience: "people", permission, allowedUserIds };
  }
  return { audience: "team", permission };
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
  // "people" shares the team ACL; the gateway allowlist narrows it per user.
  if (model.audience === "team" || model.audience === "people") {
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
