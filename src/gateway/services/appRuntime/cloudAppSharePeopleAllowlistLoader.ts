/**
 * Load audience "people" allowlists for Cloud App Host.
 *
 * Memory grants team/public_read broadly; narrowing happens here before
 * canRead/canWrite. Allowlists are written to memory on publish; desktop
 * also keeps them in cloud-publish-prefs.json (often not present on Cloud Run).
 */

import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import type { CloudPublishAppPrefs } from "../cloudPublishPrefs.js";
import { loadCloudPublishPrefs } from "../cloudPublishPrefs.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import type { SharePeopleAllowlist } from "./cloudAppPeopleAccess.js";
import { getCloudAppHostKey, runtimeFetch } from "./memoryRuntimeClient.js";
import type { AppRuntimeRouteAuth } from "./types.js";

export const CLOUD_PUBLISH_PREFS_REPO_PATH = "data/cloud-publish-prefs.json";

export function sharePeopleAllowlistFromAppPrefs(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  > | undefined,
): SharePeopleAllowlist | undefined {
  if (!prefs) {
    return undefined;
  }
  const allowedUserIds = prefs.allowedUserIds;
  const allowedEmails = prefs.allowedEmails;
  const allowedEmailDomains = prefs.allowedEmailDomains;
  if (
    (allowedUserIds?.length ?? 0) === 0 &&
    (allowedEmails?.length ?? 0) === 0 &&
    (allowedEmailDomains?.length ?? 0) === 0
  ) {
    return undefined;
  }
  return { allowedUserIds, allowedEmails, allowedEmailDomains };
}

export function parseSharePeopleAllowlistFromPrefsFile(
  rawJson: string,
  appId: string,
): SharePeopleAllowlist | undefined {
  try {
    const parsed = JSON.parse(rawJson) as { apps?: Record<string, CloudPublishAppPrefs> };
    if (!parsed.apps || typeof parsed.apps !== "object") {
      return undefined;
    }
    return sharePeopleAllowlistFromAppPrefs(parsed.apps[appId]);
  } catch {
    return undefined;
  }
}

const MEMORY_ALLOWLIST_TTL_MS = 60_000;
const memoryAllowlistCache = new Map<
  string,
  { allowlist: SharePeopleAllowlist | undefined; expiresAt: number }
>();

/** Publish record on memory (source of truth after desktop publish). */
export async function fetchShareAllowlistFromMemoryPublish(
  appId: string,
): Promise<SharePeopleAllowlist | undefined> {
  const cached = memoryAllowlistCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.allowlist;
  }

  let allowlist: SharePeopleAllowlist | undefined;
  try {
    const resp = await runtimeFetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
      {
        method: "GET",
        headers: {
          "X-Cloud-App-Host-Key": getCloudAppHostKey(),
        },
      },
      15_000,
    );
    if (!resp.ok) {
      allowlist = undefined;
    } else {
      const payload = (await resp.json()) as Pick<
        CloudPublishAppPrefs,
        "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
      > & {
        shareAllowlist?: Pick<
          CloudPublishAppPrefs,
          "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
        >;
      };
      allowlist =
        sharePeopleAllowlistFromAppPrefs(payload.shareAllowlist) ??
        sharePeopleAllowlistFromAppPrefs(payload);
    }
  } catch {
    allowlist = undefined;
  }

  memoryAllowlistCache.set(appId, {
    allowlist,
    expiresAt: Date.now() + MEMORY_ALLOWLIST_TTL_MS,
  });
  return allowlist;
}

export function invalidateMemoryShareAllowlistCache(appId?: string): void {
  if (appId) {
    memoryAllowlistCache.delete(appId);
    return;
  }
  memoryAllowlistCache.clear();
}

/** Local prefs → repo file → memory publish record (Cloud Run). */
export async function loadSharePeopleAllowlistForCloudHost(
  runtimeAuth: AppRuntimeRouteAuth,
  appId: string,
): Promise<SharePeopleAllowlist | undefined> {
  const local = sharePeopleAllowlistFromAppPrefs(loadCloudPublishPrefs().apps[appId]);
  if (local) {
    return local;
  }

  try {
    const file = await fetchCachedRuntimeRepoFile(
      runtimeAuth,
      CLOUD_PUBLISH_PREFS_REPO_PATH,
    );
    if (file?.content) {
      const fromRepo = parseSharePeopleAllowlistFromPrefsFile(file.content, appId);
      if (fromRepo) {
        return fromRepo;
      }
    }
  } catch {
    /* fall through to memory */
  }

  return fetchShareAllowlistFromMemoryPublish(appId);
}
