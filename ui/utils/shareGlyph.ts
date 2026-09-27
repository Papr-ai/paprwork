/**
 * Who can open an app, reduced to the same audience glyph the share bar uses
 * (lock / people / person-check / link / globe) plus the "can copy the code"
 * badge. One mapping for library cards and Team/Community catalog cards.
 */
import type { CloudPublishState } from "./cloudPublishApi";
import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import {
  isLinkOnlyVisibility,
  isTeamSharedVisibility,
} from "../../src/core/types/communityCatalog";
import {
  sharingToAudienceModel,
  type ShareAudience,
} from "./shareAudienceModel";

export interface ShareGlyph {
  audience: ShareAudience;
  codeAccess: "off" | "install";
}

const PRIVATE: ShareGlyph = { audience: "private", codeAccess: "off" };

/** From the cached publish state the Apps grid already reads for "Live". */
export function shareGlyphForPublishState(
  state: CloudPublishState | null | undefined,
): ShareGlyph {
  if (!state?.shareUrl) return PRIVATE;
  const prefs = state.prefs ?? {};
  const codeAccess = prefs.codeAccess ?? "off";
  const model = sharingToAudienceModel(
    state.loginAccess ?? prefs.loginAccess ?? "private",
    state.externalLink ?? prefs.externalLink ?? "off",
    codeAccess,
    {
      requireSignIn: prefs.requireSignIn,
      perUserIsolation: prefs.perUserIsolation,
      allowedUserIds: prefs.allowedUserIds,
      allowedEmails: prefs.allowedEmails,
      allowedEmailDomains: prefs.allowedEmailDomains,
    },
  );
  return {
    audience: model.audience,
    codeAccess: model.permission === "edit" ? "install" : "off",
  };
}

/** From catalog visibility — the catalog never carries a people allowlist. */
export function shareGlyphForCatalogEntry(
  entry: CommunityCatalogEntry,
): ShareGlyph {
  if (entry.source === "opensource")
    return { audience: "public", codeAccess: "install" };
  const codeAccess = entry.codeInstallable ? "install" : "off";
  if (isTeamSharedVisibility(entry.visibility))
    return { audience: "team", codeAccess };
  if (
    isLinkOnlyVisibility(entry.visibility) ||
    entry.shareLinkEnabled === true
  ) {
    return { audience: "link", codeAccess };
  }
  return { audience: "public", codeAccess };
}
