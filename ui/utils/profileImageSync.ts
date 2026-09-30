/**
 * Profile photo sync: cloud is primary, local is fallback while upload is pending.
 */

import { gateway } from "../src/lib/gateway";
import {
  isProfileImagePendingSync,
  resolveDisplayProfileImage,
} from "./profileImageSyncCore.js";

export { isProfileImagePendingSync, resolveDisplayProfileImage };

export interface ProfileImageCloudSyncInput {
  name: string;
  email: string;
  imageUrl: string;
}

export interface ProfileImageCloudSyncResult {
  success: boolean;
  cloudUrl?: string;
  error?: string;
}

export async function syncProfileImageToCloud(
  fields: ProfileImageCloudSyncInput,
): Promise<ProfileImageCloudSyncResult> {
  const loginStatus = await window.electronAPI.papr.checkLoginStatus();
  if (!loginStatus.success || !loginStatus.isLoggedIn) {
    return { success: false, error: "Not logged in" };
  }

  const syncResult = await window.electronAPI.papr.syncProfile({
    name: fields.name,
    email: fields.email,
    imageUrl: fields.imageUrl,
  });

  if (!syncResult.success) {
    return { success: false, error: syncResult.error };
  }

  const cloudUrl =
    syncResult.syncedImageUrl?.trim() ||
    syncResult.profileImageUrl?.trim();
  return cloudUrl ? { success: true, cloudUrl } : { success: true };
}

export interface PersistProfileFieldsInput {
  name: string;
  email: string;
  imageUrl: string;
  profileImageSyncPending?: boolean;
}

export async function persistProfileFields(
  fields: PersistProfileFieldsInput,
): Promise<void> {
  await gateway.send("settings:save-profile", fields);
}

/**
 * Retry uploading a pending local photo to Papr. Returns cloud URL when sync succeeds.
 */
export async function retryPendingProfileImageSync(
  name: string,
  email: string,
  imageUrl: string,
  syncPending?: boolean,
): Promise<{ cloudUrl?: string }> {
  if (!isProfileImagePendingSync(imageUrl, syncPending)) {
    return {};
  }

  const result = await syncProfileImageToCloud({ name, email, imageUrl });
  if (!result.success || !result.cloudUrl) {
    return {};
  }

  await persistProfileFields({
    name,
    email,
    imageUrl: result.cloudUrl,
    profileImageSyncPending: false,
  });

  return { cloudUrl: result.cloudUrl };
}
