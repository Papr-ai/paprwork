/**
 * App preview videos (client side). See src/gateway/services/appDemoVideos.ts.
 *
 * - One request tells the library which apps have a video (no 404 per card).
 * - Generation runs in the gateway; a module-level poller follows it even after the
 *   sheet that started it closes, then tells every card to refresh.
 */
import { useEffect, useState } from "react";
import { getGatewayHttpBase } from "./gatewayHttpBase";

export const APP_DEMO_CHANGED_EVENT = "papr:app-demo-changed";

export type DemoStage = "writing" | "recording" | "reviewing" | "polishing" | "revising" | "screens";
export interface DemoScreen {
  t: number;
  crop: { x: number; y: number; w: number; h: number };
  caption: string;
  hidden?: boolean;
}
export interface DemoVersion {
  v: number;
  createdAt: number;
  kind: "create" | "revise";
  notes?: number;
  screens?: DemoScreen[];
}
export interface DemoNote {
  id: string;
  v: number;
  t: number;
  /** Gallery screen it is about (1-based); absent = the video. */
  on?: number;
  x?: number;
  y?: number;
  body: string;
  createdAt: number;
  fixedIn?: number;
}
export interface DemoStatus {
  exists: boolean;
  updatedAt: number | null;
  sharedKind?: "video" | "image" | null;
  task: {
    state: "running" | "done" | "failed";
    kind?: "create" | "revise";
    stage?: DemoStage;
    startedAt: number;
    error?: string;
    version?: number;
  } | null;
  current?: number;
  /** Last version opened in the Gallery; current > seen means "Review gallery". */
  seen?: number;
  versions?: DemoVersion[];
  notes?: DemoNote[];
}

const base = (appId: string) => `${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/demo`;

export function appDemoVideoUrl(appId: string, version?: number | string | null): string {
  return `${base(appId)}/video${version ? `?v=${version}` : ""}`;
}
/** One saved version (v1, v2…), not the one in use. */
export function appDemoVersionUrl(appId: string, ver: number, kind: "video" | "poster" = "video"): string {
  return `${base(appId)}/${kind}?ver=${ver}`;
}
export function appDemoPosterUrl(appId: string, version?: number | string | null): string {
  return `${base(appId)}/poster${version ? `?v=${version}` : ""}`;
}

/** One gallery screen (k is 1-based) of the version in use, or of version ver. */
export function appDemoScreenUrl(appId: string, k: number, ver?: number, bust?: number | null): string {
  const q = [ver ? `ver=${ver}` : "", bust ? `b=${bust}` : ""].filter(Boolean).join("&");
  return `${base(appId)}/screens/${k}${q ? `?${q}` : ""}`;
}

/** Gallery progress as the bar shows it: four steps for a first make, the version for a revise. */
export function galleryProgress(s: DemoStatus | null): { label: string; busy: boolean } | null {
  if (s?.task?.state === "running") {
    if (s.task.kind === "revise" && s.task.stage !== "screens") {
      return { label: `Making v${Math.max(0, ...(s.versions ?? []).map((v) => v.v)) + 1}`, busy: true };
    }
    const step = { writing: 1, recording: 2, reviewing: 3, polishing: 3, revising: 3, screens: 4 }[s.task.stage ?? "writing"];
    return { label: `Gallery ${step} of 4`, busy: true };
  }
  if ((s?.current ?? 0) > (s?.seen ?? 0)) return { label: "Review gallery", busy: false };
  return null;
}

export async function fetchDemoStatus(appId: string): Promise<DemoStatus | null> {
  try {
    const r = await fetch(base(appId), { cache: "no-store" });
    return r.ok ? ((await r.json()) as DemoStatus) : null;
  } catch {
    return null;
  }
}

// ── Generation ─────────────────────────────────────────────────────────────
const followers = new Map<string, Set<(s: DemoStatus) => void>>();
const polling = new Set<string>();

function follow(appId: string): void {
  if (polling.has(appId)) return;
  polling.add(appId);
  const tick = async () => {
    const s = await fetchDemoStatus(appId);
    if (s) followers.get(appId)?.forEach((f) => f(s));
    if (s?.task?.state === "running") {
      setTimeout(tick, 1500);
      return;
    }
    polling.delete(appId);
    if (s?.task?.state === "done") {
      window.dispatchEvent(new CustomEvent(APP_DEMO_CHANGED_EVENT, { detail: { appId, version: s.updatedAt } }));
    }
  };
  void tick();
}

/** Start making the preview video (joins a run already in progress). */
export async function startDemoGeneration(appId: string): Promise<DemoStatus | null> {
  const r = await fetch(`${base(appId)}/generate`, { method: "POST" });
  const s = (await r.json().catch(() => null)) as (DemoStatus & { error?: string }) | null;
  if (!r.ok) throw new Error(s?.error ?? "Couldn't start the preview video.");
  follow(appId);
  return s;
}

/** Live status for one app; resumes following a run started elsewhere. */
export function useDemoStatus(appId: string): DemoStatus | null {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const set = (s: DemoStatus) => alive && setStatus(s);
    const subs = followers.get(appId) ?? new Set();
    subs.add(set);
    followers.set(appId, subs);
    void fetchDemoStatus(appId).then((s) => {
      if (!s) return;
      set(s);
      if (s.task?.state === "running") follow(appId);
    });
    return () => {
      alive = false;
      subs.delete(set);
    };
  }, [appId]);
  return status;
}

async function send(appId: string, pathName: string, method: string, body?: unknown): Promise<DemoStatus> {
  const r = await fetch(`${base(appId)}${pathName}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = (await r.json().catch(() => ({}))) as DemoStatus & { error?: string };
  if (!r.ok) throw new Error(out.error ?? "Something went wrong.");
  return out;
}

/** Notes refresh every follower so the sheet shows them at once. */
async function sendAndRefresh(appId: string, pathName: string, method: string, body?: unknown): Promise<void> {
  await send(appId, pathName, method, body);
  const s = await fetchDemoStatus(appId);
  if (s) followers.get(appId)?.forEach((f) => f(s));
}

export function addDemoNote(appId: string, note: { t: number; body: string; on?: number; x?: number; y?: number }): Promise<void> {
  return sendAndRefresh(appId, "/notes", "POST", note);
}
export function deleteDemoNote(appId: string, noteId: string): Promise<void> {
  return sendAndRefresh(appId, `/notes/${encodeURIComponent(noteId)}`, "DELETE");
}
export function updateDemoScreen(appId: string, k: number, patch: { caption?: string; hidden?: boolean }): Promise<void> {
  return sendAndRefresh(appId, `/screens/${k}`, "PATCH", patch);
}
/** The owner opened the Gallery. */
export function markGallerySeen(appId: string): Promise<void> {
  return sendAndRefresh(appId, "/seen", "POST");
}
/** Copies the video and kept screens to ~/Downloads; returns the folder. */
export async function downloadGallery(appId: string): Promise<string> {
  const out = (await send(appId, "/download", "POST")) as unknown as { folder?: string };
  return out.folder ?? "";
}
/** Use a saved version as the preview (cards update). */
export async function useDemoVersion(appId: string, version: number): Promise<void> {
  await sendAndRefresh(appId, "/current", "POST", { version });
  window.dispatchEvent(new CustomEvent(APP_DEMO_CHANGED_EVENT, { detail: { appId, version: Date.now() } }));
}
/** One run fixes every open note → next version. */
export async function reviseDemo(appId: string): Promise<void> {
  await send(appId, "/revise", "POST");
  follow(appId);
}

export async function shareDemoVideo(appId: string): Promise<boolean> {
  const r = await fetch(`${base(appId)}/share`, { method: "POST" });
  const body = (await r.json().catch(() => ({}))) as { shared?: boolean };
  return body.shared === true;
}

// ── Which apps have a video ────────────────────────────────────────────────
const KEY = "papr-app-demos:v1";
let have: Set<string> | null = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
})();
const versions = new Map<string, number>();
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function refresh(): Promise<void> {
  if (Date.now() - fetchedAt < 30_000) return Promise.resolve();
  fetchedAt = Date.now();
  inflight ??= fetch(`${getGatewayHttpBase()}/api/apps/demos`)
    .then((r) => (r.ok ? (r.json() as Promise<{ appIds?: string[] }>) : null))
    .then((body) => {
      if (!body?.appIds) return;
      have = new Set(body.appIds);
      try {
        localStorage.setItem(KEY, JSON.stringify(body.appIds));
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
  window.addEventListener(APP_DEMO_CHANGED_EVENT, (e) => {
    const d = (e as CustomEvent<{ appId?: string; version?: number }>).detail;
    if (!d?.appId) return;
    have = new Set([...(have ?? []), d.appId]);
    versions.set(d.appId, d.version ?? Date.now());
    listeners.forEach((l) => l());
  });
}

/** The app's preview video + poster when it has one, else null. */
export function useAppDemo(appId: string): { video: string; poster: string } | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void refresh();
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (!have?.has(appId)) return null;
  const v = versions.get(appId);
  return { video: appDemoVideoUrl(appId, v), poster: appDemoPosterUrl(appId, v) };
}

/** All apps that have a preview video (re-renders when one is added). */
export function useAppDemoIds(): Set<string> {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void refresh();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return have ?? new Set();
}
