/**
 * Gateway API for App Files — the desktop panel's view of /api/files/*.
 *
 * Uploads deliberately go through the desktop path (`filePath`) rather than
 * the browser blob path: the file is already on this machine, so streaming it
 * from disk avoids loading it into the renderer at all. The browser SDK exists
 * for mini-apps, where there is no filesystem to read from.
 */

import type { AppFileRow } from "../../src/gateway/services/appFiles/appFilesSchema";
import { getGatewayHttpBase } from "./gatewayHttpBase";

const GATEWAY = getGatewayHttpBase();

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail.slice(0, 200) || `Request failed (${res.status})`);
  }
  // A 200 carrying HTML means the SPA fallback answered instead of the API —
  // the gateway is still booting, or its routes are not registered yet.
  // Without this check res.json() throws "Unexpected token <", which sends
  // whoever debugs it looking for a JSON bug that does not exist.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Gateway is still starting — try again in a moment.");
  }
  return (await res.json()) as T;
}

export async function listAppFiles(appId: string): Promise<AppFileRow[]> {
  const body = await call<{ files: AppFileRow[] }>(
    `/api/files?appId=${encodeURIComponent(appId)}`,
  );
  return body.files ?? [];
}

export async function uploadAppFile(
  appId: string,
  filePath: string,
  options: { scope?: "app" | "user"; mime?: string } = {},
): Promise<{ id: string; verified: boolean; deduped: boolean }> {
  return call(`/api/files/upload`, {
    appId,
    filePath,
    scope: options.scope,
    mime: options.mime,
  });
}

export async function removeAppFile(appId: string, id: string): Promise<boolean> {
  const body = await call<{ deleted: boolean }>(`/api/files/delete`, { appId, id });
  return body.deleted;
}

/** Mark a file "never publish me", or undo it. */
export async function setAppFilePrivacy(
  appId: string,
  id: string,
  isPrivate: boolean,
): Promise<{ visibility: string }> {
  return call(`/api/files/visibility`, { appId, id, isPrivate });
}

/** Drop the local copy, keeping the cloud one. Never called automatically. */
export async function evictAppFile(
  appId: string,
  objectKey: string,
): Promise<boolean> {
  const body = await call<{ evicted: boolean }>(`/api/files/evict`, {
    appId,
    objectKey,
  });
  return body.evicted;
}
