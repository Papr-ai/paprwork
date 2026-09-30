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
import { getSharePeopleAllowlistPush } from "./cloudAppHostShareAllowlistPushStore.js";
import { getCloudAppHostKey, runtimeFetch } from "./memoryRuntimeClient.js";
import {
  parseSharePeopleAllowlistRepoFile,
  SHARE_PEOPLE_ALLOWLIST_REPO_PATH,
} from "./sharePeopleAllowlistRepoArtifact.js";
import { sharePeopleAllowlistFromFields } from "./sharePeopleAllowlistFields.js";
import type { AppRuntimeRouteAuth } from "./types.js";

export const CLOUD_PUBLISH_PREFS_REPO_PATH = "data/cloud-publish-prefs.json";

/** @deprecated use sharePeopleAllowlistFromFields */
export function sharePeopleAllowlistFromAppPrefs(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  > | undefined,
): SharePeopleAllowlist | undefined {
  return sharePeopleAllowlistFromFields(prefs);
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
    return sharePeopleAllowlistFromFields(parsed.apps[appId]);
  } catch {
    return undefined;
  }
}

const MEMORY_ALLOWLIST_TTL_MS = 60_000;
const memoryAllowlistCache = new Map<
  string,
  { allowlist: SharePeopleAllowlist | undefined; expiresAt: number }
>();

async function fetchShareAllowlistFromMemoryRuntime(
  runtimeAuth: AppRuntimeRouteAuth,
  appId: string,
): Promise<SharePeopleAllowlist | undefined> {
  try {
    const resp = await runtimeFetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/share-people-allowlist`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cloud-App-Host-Key": getCloudAppHostKey(),
        },
        body: JSON.stringify({
          namespaceId: runtimeAuth.namespaceId,
          slug: runtimeAuth.slug,
          appId,
        }),
      },
      15_000,
    );
    if (resp.status === 404) {
      return undefined;
    }
    if (!resp.ok) {
      return undefined;
    }
    const payload = (await resp.json()) as {
      shareAllowlist?: Pick<
        CloudPublishAppPrefs,
        "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
      >;
      allowedUserIds?: string[];
      allowedEmails?: string[];
      allowedEmailDomains?: string[];
    };
    return (
      sharePeopleAllowlistFromFields(payload.shareAllowlist) ??
      sharePeopleAllowlistFromFields(payload)
    );
  } catch {
    return undefined;
  }
}

/** Publish record on memory (owner auth — host key alone usually 401). */
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
        sharePeopleAllowlistFromFields(payload.shareAllowlist) ??
        sharePeopleAllowlistFromFields(payload);
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

/** Local prefs → host push → app repo file → workspace prefs file → memory. */
export async function loadSharePeopleAllowlistForCloudHost(
  runtimeAuth: AppRuntimeRouteAuth,
  appId: string,
): Promise<SharePeopleAllowlist | undefined> {
  const local = sharePeopleAllowlistFromFields(loadCloudPublishPrefs().apps[appId]);
  if (local) {
    return local;
  }

  const pushed = getSharePeopleAllowlistPush(
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
    appId,
  );
  if (pushed) {
    return pushed;
  }

  try {
    const perAppFile = await fetchCachedRuntimeRepoFile(
      runtimeAuth,
      SHARE_PEOPLE_ALLOWLIST_REPO_PATH,
    );
    if (perAppFile?.content) {
      const fromRepo = parseSharePeopleAllowlistRepoFile(perAppFile.content);
      if (fromRepo) {
        return fromRepo;
      }
    }
  } catch {
    /* fall through */
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

  const fromRuntime = await fetchShareAllowlistFromMemoryRuntime(runtimeAuth, appId);
  if (fromRuntime) {
    return fromRuntime;
  }

  return fetchShareAllowlistFromMemoryPublish(appId);
}
