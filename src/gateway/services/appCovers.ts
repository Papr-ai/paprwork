/**
 * App covers — a picture of each app's first screen for the Apps library.
 *
 * Two slots, never mixed:
 *  - PRIVATE  <papr>/data/covers/{appId}.img — the newest screenshot from *this*
 *             user (agent validate_app preview, or the open app tab at most once a
 *             day). Shows real data, so it is gitignored and never leaves the machine.
 *  - SHARED   apps/{appId}/.papr/cover.img — only written when the owner explicitly
 *             approves ("Use as shared cover"). Syncs with the app code.
 *
 * Readers get their own private cover first, then the owner's shared one, else none
 * (the card falls back to the icon). Someone else's private cover is never served.
 */
import * as fs from "fs";
import * as path from "path";
import { getPaprAppsRoot, getPaprDataDir } from "../../core/utils/paprRoot.js";

export type CoverSource = "validate" | "tab";
export type CoverSlot = "private" | "shared";

/** Tab captures refresh at most once a day; validate captures always win (code changed). */
export const TAB_CAPTURE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A near-blank screenshot (loading / empty shell) compresses to almost nothing. */
const MIN_COVER_BYTES = 4_000;
const MAX_COVER_BYTES = 2_000_000;

const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isValidCoverAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

export function privateCoverPath(appId: string): string {
  return path.join(getPaprDataDir(), "covers", `${appId}.img`);
}

export function sharedCoverPath(appId: string): string {
  return path.join(getPaprAppsRoot(), appId, ".papr", "cover.img");
}

function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    return Buffer.from(m[2]!, "base64");
  } catch {
    return null;
  }
}

/** Content type from magic bytes (files are stored extension-less). */
export function sniffImageType(buf: Buffer): string {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function ageMs(file: string): number | null {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

export type SaveCoverResult =
  | { saved: true; bytes: number }
  | { saved: false; reason: "invalid_app" | "bad_image" | "blank" | "too_large" | "fresh" };

/** Save the newest private cover. Tab captures are throttled to once a day. */
export function savePrivateCover(
  appId: string,
  dataUrl: string,
  source: CoverSource,
): SaveCoverResult {
  if (!isValidCoverAppId(appId)) return { saved: false, reason: "invalid_app" };
  const file = privateCoverPath(appId);
  if (source === "tab") {
    const age = ageMs(file);
    if (age !== null && age < TAB_CAPTURE_INTERVAL_MS) return { saved: false, reason: "fresh" };
  }
  const buf = decodeDataUrl(dataUrl);
  if (!buf) return { saved: false, reason: "bad_image" };
  if (buf.length > MAX_COVER_BYTES) return { saved: false, reason: "too_large" };
  // Keep the previous picture rather than replace it with a loading/empty screen.
  if (buf.length < MIN_COVER_BYTES) return { saved: false, reason: "blank" };
  writeAtomic(file, buf);
  return { saved: true, bytes: buf.length };
}

/** Whether a tab capture would be accepted right now (lets the UI skip capturing). */
export function privateCoverIsFresh(appId: string): boolean {
  if (!isValidCoverAppId(appId)) return true;
  const age = ageMs(privateCoverPath(appId));
  return age !== null && age < TAB_CAPTURE_INTERVAL_MS;
}

/** Own private cover first, then the owner-approved shared one. */
export function resolveCover(appId: string): { file: string; slot: CoverSlot } | null {
  if (!isValidCoverAppId(appId)) return null;
  const priv = privateCoverPath(appId);
  if (fs.existsSync(priv)) return { file: priv, slot: "private" };
  const shared = sharedCoverPath(appId);
  if (fs.existsSync(shared)) return { file: shared, slot: "shared" };
  return null;
}

/** Owner approval: publish the current private cover as the shared one. */
export function sharePrivateCover(appId: string): boolean {
  if (!isValidCoverAppId(appId)) return false;
  const priv = privateCoverPath(appId);
  if (!fs.existsSync(priv)) return false;
  writeAtomic(sharedCoverPath(appId), fs.readFileSync(priv));
  return true;
}

export function removeSharedCover(appId: string): boolean {
  if (!isValidCoverAppId(appId)) return false;
  try {
    fs.unlinkSync(sharedCoverPath(appId));
    return true;
  } catch {
    return false;
  }
}

export function coverStatus(appId: string): {
  hasPrivate: boolean;
  hasShared: boolean;
  privateFresh: boolean;
} {
  return {
    hasPrivate: isValidCoverAppId(appId) && fs.existsSync(privateCoverPath(appId)),
    hasShared: isValidCoverAppId(appId) && fs.existsSync(sharedCoverPath(appId)),
    privateFresh: privateCoverIsFresh(appId),
  };
}
