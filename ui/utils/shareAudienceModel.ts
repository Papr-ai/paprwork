/**
 * Re-export shared share UI model from core (used by renderer + gateway tests).
 */

export type {
  CloudExternalLink,
  CloudLoginAccess,
  CodeAccess,
  ShareAudience,
  ShareAudienceModel,
  SharePermission,
} from "../../src/core/utils/shareAudienceModel.js";

export {
  audienceModelToPublishPrefs,
  audienceModelToSharing,
  codeAccessToPermission,
  communityCodeInstallable,
  isCodePermission,
  isPermissionAvailable,
  isWebLinkPermission,
  normalizeAllowedEmailDomains,
  normalizeAllowedEmails,
  normalizeEmail,
  normalizeEmailDomain,
  peopleAudienceUsesExternalGate,
  permissionAffectsCloud,
  permissionToCodeAccess,
  publishPrefsToAudienceModel,
  resolveLivePermissionForEdit,
  shareAudienceHasPeopleRestriction,
  sharingToAudienceModel,
  shouldListInCommunity,
} from "../../src/core/utils/shareAudienceModel.js";
