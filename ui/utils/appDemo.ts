/**
 * App preview loops (client side). See src/gateway/services/appDemoScenes.ts.
 * One request tells the library which apps have a loop; cards then play it in an iframe.
 */
import { useEffect, useState } from "react";
import { getGatewayHttpBase } from "./gatewayHttpBase";

export const APP_DEMO_CHANGED_EVENT = "papr:app-demo-changed";

export function appDemoUrl(appId: string, opts: { cover?: boolean; version?: string | number } = {}): string {
  const q = new URLSearchParams({ play: "1" });
  if (opts.cover) q.set("fit", "cover");
  if (opts.version !== undefined) q.set("v", String(opts.version));
  return `${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/demo-scene?${q}`;
}

let demos: Set<string> | null = null;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let version = Date.now();
const listeners = new Set<() => void>();

function refresh(force = false): Promise<void> {
  if (!force && Date.now() - fetchedAt < 30_000) return Promise.resolve();
  fetchedAt = Date.now();
  inflight ??= fetch(`${getGatewayHttpBase()}/api/apps/demos`)
    .then((r) => (r.ok ? (r.json() as Promise<{ appIds?: string[] }>) : null))
    .then((body) => {
      if (!body?.appIds) return;
      demos = new Set(body.appIds);
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

if (typeof window !== "undefined") {
  window.addEventListener(APP_DEMO_CHANGED_EVENT, (e) => {
    const id = (e as CustomEvent<{ appId?: string }>).detail?.appId;
    if (!id) return;
    demos = new Set([...(demos ?? []), id]);
    version = Date.now();
    listeners.forEach((l) => l());
  });
}

/** The loop's url when this app has one (cover-fit for cards), else null. */
export function useAppDemoUrl(appId: string): string | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void refresh();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return demos?.has(appId) ? appDemoUrl(appId, { cover: true, version }) : null;
}
