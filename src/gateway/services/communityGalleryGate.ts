/**
 * Community listings need an approved gallery (Share Bar Redesign v10).
 *
 * The Share sheet asks for the Gallery as the last step when Community is turned on;
 * this is the same rule on the gateway so nothing lists without one. Only a save that
 * newly opens Community is checked: apps that are already listed stay listed (and can
 * change their Community role) with or without a gallery.
 */

type Role = "none" | "viewer" | "contributor" | "maintainer" | "admin" | string;

export interface AccessPatchLike {
  communityRole?: Role;
}

export interface AccessStateLike {
  communityRole?: Role;
  audiences?: { community?: boolean };
}

const on = (r: Role | undefined): boolean => Boolean(r) && r !== "none";

/** Community is open on the server right now. */
export function communityOpen(a: AccessStateLike | null | undefined): boolean {
  if (!a) return false;
  return a.audiences ? a.audiences.community === true : on(a.communityRole);
}

/** True when this PUT would newly list the app in Community without an approved gallery. */
export function blocksCommunityListing(
  patch: AccessPatchLike | null | undefined,
  current: AccessStateLike | null | undefined,
  hasGallery: boolean,
): boolean {
  if (hasGallery || !patch || !on(patch.communityRole)) return false;
  return !communityOpen(current);
}

export const COMMUNITY_NEEDS_GALLERY =
  "Listing in Community needs a gallery. Generate one in Share, then List in Community.";
