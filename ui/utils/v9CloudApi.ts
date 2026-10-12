/** Small gateway calls for the v9 share bar pieces (draft, last merge, data check). */

import type { ScopedTable } from "../../src/core/utils/tableScope";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

const app = (appId: string, rest: string) => `${GATEWAY}/api/${rest.replace(":id", encodeURIComponent(appId))}`;

export async function draftProposal(appId: string): Promise<{ title: string; description: string }> {
  const res = await fetch(app(appId, "cloud/apps/:id/proposal-draft"), { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { title?: string; description?: string; error?: string };
  if (!res.ok || !body.title || !body.description) {
    throw new Error(body.error ?? "Couldn't write a draft");
  }
  return { title: body.title, description: body.description };
}

export interface LastMerge {
  actorUserId: string | null;
  title: string | null;
  publishedDirectly: boolean;
  at: string;
}

export async function fetchLastMerge(appId: string): Promise<LastMerge | null> {
  try {
    const res = await fetch(app(appId, "cloud/apps/:id/last-merge"));
    if (!res.ok) return null;
    return ((await res.json()) as { merge?: LastMerge | null }).merge ?? null;
  } catch {
    return null;
  }
}

/** Maintainer accepted from their copy: pull it now (held on overlaps). */
export async function pullAfterAccept(appId: string): Promise<void> {
  await fetch(app(appId, "cloud/apps/:id/pull-after-accept"), { method: "POST" }).catch(() => undefined);
}

export async function fetchTableScopes(appId: string): Promise<ScopedTable[] | null> {
  try {
    const res = await fetch(app(appId, "apps/:id/table-scope"));
    if (!res.ok) return null;
    return ((await res.json()) as { tables?: ScopedTable[] }).tables ?? [];
  } catch {
    return null;
  }
}
