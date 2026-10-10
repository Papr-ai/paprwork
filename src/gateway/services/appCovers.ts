/**
 * App covers — a picture of each app's first screen for the Apps library.
 *
 * Two slots, never mixed:
 *  - PRIVATE  <papr>/data/covers/{appId}.img — the newest screenshot from *this*
 *             user (agent validate_app preview, or the open app tab at most once a
 *             day). Shows real data, so it is gitignored and never leaves the machine.
 *  - SHARED   an App File (scope "app", CDN-public) uploaded only when the owner approves
 *             it (publish sheet / More → App info). apps/{appId}/papr-cover.json holds the
 *             pointer {appFileId, objectKey, url}; it is text, so git sync carries it, and the
 *             cloud host redirects /{ns}/{slug}/papr-cover to the CDN url. Apps with no
 *             database for App Files fall back to papr-cover.txt (inline data URL).
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

export const SHARED_COVER_FILE = "papr-cover.txt";
export const SHARED_COVER_POINTER = "papr-cover.json";

export interface SharedCoverPointer {
  appFileId: string;
  objectKey: string;
  url: string;
}

const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isValidCoverAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

export function sharedCoverPointerPath(appId: string): string {
  return path.join(getPaprAppsRoot(), appId, SHARED_COVER_POINTER);
}

export function readSharedCoverPointer(appId: string): SharedCoverPointer | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sharedCoverPointerPath(appId), "utf8")) as Partial<SharedCoverPointer>;
    return raw.appFileId && raw.objectKey && raw.url ? (raw as SharedCoverPointer) : null;
  } catch {
    return null;
  }
}

export function privateCoverPath(appId: string): string {
  return path.join(getPaprDataDir(), "covers", `${appId}.img`);
}

export function sharedCoverPath(appId: string): string {
  return path.join(getPaprAppsRoot(), appId, SHARED_COVER_FILE);
}

export function decodeDataUrl(dataUrl: string): Buffer | null {
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

/** Own private cover first, then the owner-approved shared one (App File url, or legacy inline). */
export function resolveCover(
  appId: string,
): { slot: CoverSlot; body?: Buffer; redirect?: string } | null {
  if (!isValidCoverAppId(appId)) return null;
  const priv = privateCoverPath(appId);
  if (fs.existsSync(priv)) return { body: fs.readFileSync(priv), slot: "private" };
  const pointer = readSharedCoverPointer(appId);
  if (pointer) return { redirect: pointer.url, slot: "shared" };
  const shared = sharedCoverPath(appId);
  if (fs.existsSync(shared)) {
    const body = decodeDataUrl(fs.readFileSync(shared, "utf8").trim());
    if (body) return { body, slot: "shared" };
  }
  return null;
}

/** Uploads bytes to App Files and returns the stored file's id + object key. */
export type CoverUploader = (args: {
  appId: string;
  filePath: string;
  fileName: string;
  mime: string;
}) => Promise<{ id: string; objectKey: string; url: string }>;

export type ShareCoverResult =
  | { shared: true; via: "app_files" | "inline"; url?: string }
  | { shared: false; reason: "invalid_app" | "no_cover" };

/**
 * Owner approval: store the current private cover as an App File and point the app at it.
 * Falls back to an inline data URL when the app has no database for App Files.
 */
export async function sharePrivateCover(
  appId: string,
  upload?: CoverUploader,
): Promise<ShareCoverResult> {
  if (!isValidCoverAppId(appId)) return { shared: false, reason: "invalid_app" };
  const priv = privateCoverPath(appId);
  if (!fs.existsSync(priv)) return { shared: false, reason: "no_cover" };
  const buf = fs.readFileSync(priv);
  const mime = sniffImageType(buf);
  if (upload) {
    try {
      // App Files reads from a stable path; keep a dedicated copy so later private
      // captures never change what was approved.
      const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
      const filePath = path.join(path.dirname(priv), `${appId}.shared.${ext}`);
      writeAtomic(filePath, buf);
      const stored = await upload({ appId, filePath, fileName: `cover.${ext}`, mime });
      const pointer: SharedCoverPointer = { appFileId: stored.id, objectKey: stored.objectKey, url: stored.url };
      writeAtomic(sharedCoverPointerPath(appId), Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"));
      fs.rmSync(sharedCoverPath(appId), { force: true });
      return { shared: true, via: "app_files", url: stored.url };
    } catch (err) {
      console.warn(`[appCovers] App Files upload failed for ${appId}, storing inline:`, (err as Error).message);
    }
  }
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  writeAtomic(sharedCoverPath(appId), Buffer.from(dataUrl, "utf8"));
  fs.rmSync(sharedCoverPointerPath(appId), { force: true });
  return { shared: true, via: "inline" };
}

/** Stop sharing a cover (the App File itself is left for normal App Files cleanup). */
export function removeSharedCover(appId: string): boolean {
  if (!isValidCoverAppId(appId)) return false;
  let removed = false;
  for (const file of [sharedCoverPath(appId), sharedCoverPointerPath(appId)]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed = true;
    }
  }
  return removed;
}

export function coverStatus(appId: string): {
  hasPrivate: boolean;
  hasShared: boolean;
  privateFresh: boolean;
} {
  return {
    hasPrivate: isValidCoverAppId(appId) && fs.existsSync(privateCoverPath(appId)),
    hasShared:
      isValidCoverAppId(appId) &&
      (readSharedCoverPointer(appId) !== null || fs.existsSync(sharedCoverPath(appId))),
    privateFresh: privateCoverIsFresh(appId),
  };
}
