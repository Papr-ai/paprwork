/**
 * Pure profile photo merge logic (no gateway / Electron deps — safe for Node tests).
 */

export function isProfileImagePendingSync(
  imageUrl: string,
  syncPending?: boolean,
): boolean {
  const local = imageUrl.trim();
  if (!local) return false;
  if (syncPending === true) return true;
  return local.startsWith("data:");
}

/** Cloud wins unless we still owe Papr an upload (pending local photo). */
export function resolveDisplayProfileImage(
  localImageUrl: string,
  cloudImageUrl: string,
  syncPending?: boolean,
): string {
  const local = localImageUrl.trim();
  const cloud = cloudImageUrl.trim();
  if (isProfileImagePendingSync(local, syncPending) && local) {
    return local;
  }
  if (cloud) return cloud;
  return local;
}
