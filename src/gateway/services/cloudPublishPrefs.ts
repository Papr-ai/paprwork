/**
 * Local preferences for cloud mini-app links (auto-publish, access mode).
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";

import type { CodeAccess } from "../../core/utils/shareAudienceModel.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type {
  CloudExternalLink,
  CloudLoginAccess,
} from "./cloudSharingSettings.js";
import { readDerivedFromFile } from "./cloudSync/jsonFileCache.js";

export type CloudAccessMode =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export type CloudUploadModePref = "auto" | "manual" | "inherit";
export type CloudEnabledPref = true | false | "inherit";

export interface CloudPublishAppPrefs {
  autoPublish: boolean;
  /** When false, skip cloud upload for this app. inherit = follow global cloud sync. */
  cloudEnabled?: CloudEnabledPref;
  /** auto = push on change; manual = Upload now only; inherit = global cloudAutoUploadEnabled. */
  uploadMode?: CloudUploadModePref;
  accessMode: CloudAccessMode;
  /** Who can open the app after signing in with Papr. */
  loginAccess?: CloudLoginAccess;
  /** Optional secret link for people outside Papr. */
  externalLink?: CloudExternalLink;
  /** Cached from last publish — memory GET often omits shareToken. */
  shareToken?: string;
  /** Allow others to install/sync app source into Paprwork (stored locally until server ACL). */
  codeAccess?: CodeAccess;
  /** @deprecated Record only — never used to override computed ACL. */
  liveLinkPermission?: "read" | "read_write";
  /** API keys the app needs — mirrored from requirements.json for quick reads. */
  credentialRequirements?: RequiredKeySpec[];
  /** Public Community apps: require Papr sign-in before opening (default false). */
  requireSignIn?: boolean;
  /** When true, linked registry DBs use per-user Turso isolation. */
  perUserIsolation?: boolean;
  lastAutoPublishAttemptAt?: string;
  lastAutoPublishError?: string;
}

export interface CloudPublishPrefsFile {
  apps: Record<string, CloudPublishAppPrefs>;
}

const PREFS_FILENAME = "cloud-publish-prefs.json";

function prefsPath(paprDir?: string): string {
  const root = paprDir ?? getPaprRoot();
  return path.join(root, "data", PREFS_FILENAME);
}

export function loadCloudPublishPrefs(paprDir?: string): CloudPublishPrefsFile {
  const filePath = prefsPath(paprDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CloudPublishPrefsFile;
    if (parsed.apps && typeof parsed.apps === "object") {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { apps: {} };
}

export function saveCloudPublishPrefs(
  prefs: CloudPublishPrefsFile,
  paprDir?: string,
): void {
  const filePath = prefsPath(paprDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(prefs, null, 2), "utf8");
}

/**
 * Read-only prefs lookup used on sync hot paths (once per app per queue scan).
 * Writers keep using loadCloudPublishPrefs so mutations always see fresh state.
 */
export function getAppPublishPrefs(
  appId: string,
  paprDir?: string,
): CloudPublishAppPrefs {
  const prefs = readDerivedFromFile<CloudPublishPrefsFile>(
    prefsPath(paprDir),
    "cloudPublishPrefs",
    (raw) => {
      const parsed = JSON.parse(raw) as CloudPublishPrefsFile;
      return parsed.apps && typeof parsed.apps === "object"
        ? parsed
        : { apps: {} };
    },
    { apps: {} },
  );
  const entry = prefs.apps[appId];
  return entry
    ? { ...entry }
    : {
        autoPublish: true,
        accessMode: "private",
      };
}

export function setAppPublishPrefs(
  appId: string,
  update: Partial<CloudPublishAppPrefs>,
  paprDir?: string,
): CloudPublishAppPrefs {
  const prefs = loadCloudPublishPrefs(paprDir);
  const current = prefs.apps[appId] ?? {
    autoPublish: true,
    accessMode: "private" as const,
  };
  const next = { ...current, ...update };
  prefs.apps[appId] = next;
  saveCloudPublishPrefs(prefs, paprDir);
  return next;
}

/** Remove local publish prefs when an app is deleted (does not touch cloud). */
export function removeAppPublishPrefs(appId: string, paprDir?: string): void {
  const prefs = loadCloudPublishPrefs(paprDir);
  if (!(appId in prefs.apps)) {
    return;
  }
  delete prefs.apps[appId];
  saveCloudPublishPrefs(prefs, paprDir);
}
