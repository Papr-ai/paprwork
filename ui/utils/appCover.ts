/**
 * App covers (client side). See src/gateway/services/appCovers.ts for the model:
 * private cover = this user's newest screenshot (never synced); shared cover = owner-approved.
 */
import { useEffect, useState } from "react";
import { getGatewayHttpBase } from "./gatewayHttpBase";

export const APP_COVER_CHANGED_EVENT = "papr:app-cover-changed";

export function appCoverUrl(appId: string, version?: string | number): string {
  const v = version !== undefined ? `?v=${encodeURIComponent(String(version))}` : "";
  return `${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover${v}`;
}

async function coverIsFresh(appId: string): Promise<boolean> {
  try {
    const res = await fetch(`${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover/status`);
    if (!res.ok) return true;
    const body = (await res.json()) as { privateFresh?: boolean };
    return body.privateFresh !== false;
  } catch {
    return true;
  }
}

/**
 * Capture the visible app (once a day per app). Uses the already-painted window,
 * so it costs one GPU readback + a ~30KB write — and only when the cover is stale.
 */
export async function maybeCaptureAppCover(appId: string, el: HTMLElement | null): Promise<void> {
  const api = window.electronAPI?.appCover;
  if (!api || !el || document.visibilityState !== "visible") return;
  if (await coverIsFresh(appId)) return;
  const r = el.getBoundingClientRect();
  if (r.width < 200 || r.height < 150) return;
  const shot = await api.captureRect({ x: r.left, y: r.top, width: r.width, height: r.height });
  if (!shot.success || !shot.dataUrl) return;
  const res = await fetch(`${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl: shot.dataUrl, source: "tab" }),
  });
  const saved = (await res.json().catch(() => null)) as { saved?: boolean } | null;
  if (saved?.saved) {
    window.dispatchEvent(new CustomEvent(APP_COVER_CHANGED_EVENT, { detail: { appId } }));
  }
}

/** Owner approval: share (or stop sharing) the current private cover. */
export async function setAppCoverShared(appId: string, shared: boolean): Promise<boolean> {
  const res = await fetch(`${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover/share`, {
    method: shared ? "POST" : "DELETE",
  });
  const body = (await res.json().catch(() => ({}))) as { shared?: boolean; removed?: boolean };
  return shared ? body.shared === true : body.removed === true;
}

// ── Which apps have a cover ────────────────────────────────────────────────
// One request for the library instead of a 404 per card without a cover.
// Last answer is kept in localStorage so cards paint covers at once on launch.
const COVERED_KEY = "papr-app-covers:v1";
let covered: Set<string> | null = (() => {
  try {
    const raw = localStorage.getItem(COVERED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
})();
let inflight: Promise<void> | null = null;
let coveredAt = 0;
const listeners = new Set<() => void>();

function refreshCovered(): Promise<void> {
  if (Date.now() - coveredAt < 30_000) return Promise.resolve();
  coveredAt = Date.now();
  inflight ??= fetch(`${getGatewayHttpBase()}/api/apps/covers`)
    .then((r) => (r.ok ? (r.json() as Promise<{ appIds?: string[] }>) : null))
    .then((body) => {
      if (!body?.appIds) return;
      covered = new Set(body.appIds);
      try {
        localStorage.setItem(COVERED_KEY, JSON.stringify(body.appIds));
      } catch {
        /* quota */
      }
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

if (typeof window !== "undefined") {
  window.addEventListener(APP_COVER_CHANGED_EVENT, (e) => {
    const id = (e as CustomEvent<{ appId?: string }>).detail?.appId;
    if (id) {
      covered = new Set([...(covered ?? []), id]);
      listeners.forEach((l) => l());
    }
  });
}

/** True when this app has a cover to show. Unknown (first launch, before the list loads) → false. */
export function useAppHasCover(appId: string): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void refreshCovered();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return covered?.has(appId) ?? false;
}
