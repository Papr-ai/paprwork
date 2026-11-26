/**
 * publish_cloud_app requests that only change who can open the app.
 *
 * From a copy on the team's shared data these must not go through the code
 * publish path (TeamDataCopyPublishError): they are applied to the original
 * app through the audiences API, exactly like the Share sheet does, and the
 * server decides by the caller's role (Admins can, everyone else gets 403).
 */

export interface PublishRequestFields {
  loginAccess?: unknown;
  externalLink?: unknown;
  requireSignIn?: unknown;
  uploadMaxMb?: unknown;
  codeAccess?: unknown;
  perUserIsolation?: unknown;
  unpublish?: unknown;
}

const ACCESS_FIELDS = ["loginAccess", "externalLink", "requireSignIn", "uploadMaxMb"] as const;
const PUBLISH_FIELDS = ["codeAccess", "perUserIsolation", "unpublish"] as const;

/** True when the request touches access settings and nothing that needs a code publish. */
export function isAccessOnlyRequest(args: PublishRequestFields): boolean {
  const touchesAccess = ACCESS_FIELDS.some((k) => args[k] !== undefined);
  const touchesPublish = PUBLISH_FIELDS.some((k) => args[k] !== undefined && args[k] !== false);
  return touchesAccess && !touchesPublish;
}
