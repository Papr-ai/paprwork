/**
 * When the Gallery is asked for (Share Bar Redesign v10, "Gallery lives in Share").
 *
 * Only a Community listing needs a gallery. Turning Community on in Share adds a last,
 * required step (Gallery); every other audience keeps the default Papr-blue cover.
 * Apps that are already listed keep their listing, gallery or not.
 * Pure logic so the sheet, the status chip and the tests read one source.
 */
import { rank, type AppAccess, type AppRole } from "./appRolesModel";
import { draftFromAccess, type AudiencesDraft } from "./shareAudiencesModel";
import type { DemoStatus } from "./appDemo";

export type ShareV9Step = "who" | "keys" | "gallery";

/** The owner approved a gallery: the preview video is the shared cover. */
export function galleryApproved(s: DemoStatus | null | undefined): boolean {
  return s?.sharedKind === "video";
}

/** A finished video exists, so List in Community can approve it. */
export function galleryUsable(s: DemoStatus | null | undefined): boolean {
  return Boolean(s?.exists) && s?.task?.state !== "running";
}

/** This save would newly list the app in Community without an approved gallery. */
export function needsGallery(
  live: AppAccess,
  draft: Pick<AudiencesDraft, "community">,
  approved: boolean,
): boolean {
  return rank(draft.community) > 0 && rank(draftFromAccess(live).community) === 0 && !approved;
}

/** Edit steps in order: Who has access, API keys (if any), Gallery (if Community needs one). */
export function shareSteps(hasKeys: boolean, gallery: boolean): ShareV9Step[] {
  const steps: ShareV9Step[] = ["who"];
  if (hasKeys) steps.push("keys");
  if (gallery) steps.push("gallery");
  return steps;
}

// ── A listing waiting on its gallery ───────────────────────────────────────
// Closing the sheet mid-way is fine: the status chip reopens Share at the Gallery
// step with the Community role they picked. Kept per app in localStorage.
const KEY = (appId: string) => `papr-pending-community:${appId}`;
const store = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

export function pendingCommunity(appId: string): AppRole | null {
  const v = store()?.getItem(KEY(appId));
  return v === "viewer" || v === "contributor" ? v : null;
}

export function setPendingCommunity(appId: string, role: AppRole | null): void {
  const s = store();
  if (!s) return;
  if (role && rank(role) > 0) s.setItem(KEY(appId), role);
  else s.removeItem(KEY(appId));
}
