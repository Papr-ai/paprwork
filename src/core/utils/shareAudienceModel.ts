/**
 * Share UI model: audience (who) + permission (what) → cloud ACL + code access prefs.
 */

export type ShareAudience = "private" | "team" | "public" | "link";
export type CloudLoginAccess = "private" | "team" | "public" | "none";
export type CloudExternalLink = "off" | "read" | "read_write";

/** read = view live app, write = use live app, edit = install/sync source in Paprwork */
export type SharePermission = "read" | "write" | "edit";
export type CodeAccess = "off" | "install";

export interface ShareAudienceModel {
  audience: ShareAudience;
  permission: SharePermission;
  /** Link sharing only: true = Papr sign-in required (default), false = token-only */
  requireSignIn?: boolean;
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
      return { audience: "public", permission: "edit" };
    }
    if (loginAccess === "team") {
      return { audience: "team", permission: "edit" };
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
    return { audience: "public", permission: "write" };
  }
  if (loginAccess === "team") {
    return { audience: "team", permission: "write" };
  }
  return { audience: "private", permission: "read" };
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
  return { loginAccess: "private", externalLink: "off" };
}

/** When sharing code, default live access by audience. */
export function resolveLivePermissionForEdit(
  audience: ShareAudience,
): Exclude<SharePermission, "edit"> {
  if (audience === "team" || audience === "link" || audience === "public") {
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
  if (model.audience === "private" || model.audience === "team") {
    return model.permission === "read" || model.permission === "write";
  }
  return true;
}

export function isPermissionAvailable(
  audience: ShareAudience,
  permission: SharePermission,
): boolean {
  // Simplified UI: private, team, link (unlisted), public (Community catalog)
  // Both "write" (view & interact) and "edit" (code) require non-private
  if (audience === "private") {
    // Private apps don't share permissions
    return false;
  }
  // For team, link, and public, both write and edit are available
  if (permission === "write" || permission === "edit") {
    return audience === "link" || audience === "team" || audience === "public";
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
