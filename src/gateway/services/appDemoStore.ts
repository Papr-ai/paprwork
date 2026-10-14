/**
 * App preview videos — files, versions and notes (owner-only, private, never synced).
 *
 * <papr>/data/demos/
 *   {appId}.v{n}.html|.mp4|.jpg   every version the owner made (v1 = first make)
 *   {appId}.html|.mp4|.jpg        copy of the version in use (cards + sharing read these)
 *   {appId}.json                  { current, versions[], notes[] }
 *   {appId}.a|b.*, *.still-*.jpg  scratch for a run in progress
 *
 * Notes work like Launch Video Studio: a moment (t seconds), optionally a spot on the
 * frame (x, y in 0..1), and text. One Revise fixes every open note and makes a new
 * version; the notes it addressed are marked fixedIn = that version.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** Older versions beyond this are deleted (never the one in use). */
const MAX_VERSIONS = 20;
const MAX_NOTE_CHARS = 1000;

export interface DemoVersion {
  v: number;
  createdAt: number;
  kind: "create" | "revise";
  /** Notes this version addressed (revisions). */
  notes?: number;
  /** Reviewer scores when the take was judged (1-5). */
  fidelity?: number;
  polish?: number;
}

export interface DemoNote {
  id: string;
  /** Version the note was written on. */
  v: number;
  /** Seconds into the loop. */
  t: number;
  /** Spot on the frame, 0..1 from top-left. */
  x?: number;
  y?: number;
  body: string;
  createdAt: number;
  /** Version that fixed it; absent = open. */
  fixedIn?: number;
}

export interface DemoManifest {
  /** Version in use (0 = none yet). */
  current: number;
  versions: DemoVersion[];
  notes: DemoNote[];
}

export function isValidDemoAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

export function demoDir(): string {
  return path.join(getPaprDataDir(), "demos");
}

export function demoPaths(appId: string, take = "") {
  const base = path.join(demoDir(), `${appId}${take ? `.${take}` : ""}`);
  return { scene: `${base}.html`, video: `${base}.mp4`, poster: `${base}.jpg` };
}

export const versionTake = (v: number) => `v${v}`;

export function stillPath(appId: string, name: string): string {
  return path.join(demoDir(), `${appId}.still-${name}.jpg`);
}

export function hasDemoVideo(appId: string): boolean {
  return isValidDemoAppId(appId) && fs.existsSync(demoPaths(appId).video);
}

/** Every app with a finished preview video (one call for the whole library). */
export function listDemoAppIds(): string[] {
  try {
    return fs
      .readdirSync(demoDir())
      .filter((f) => /^[A-Za-z0-9_-]+\.mp4$/.test(f))
      .map((f) => f.slice(0, -4))
      .filter(isValidDemoAppId);
  } catch {
    return [];
  }
}

const manifestPath = (appId: string) => path.join(demoDir(), `${appId}.json`);

/** Manifest for one app. A video made before versions existed becomes v1. */
export function readManifest(appId: string): DemoManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(appId), "utf8")) as Partial<DemoManifest>;
    return { current: raw.current ?? 0, versions: raw.versions ?? [], notes: raw.notes ?? [] };
  } catch {
    /* none yet */
  }
  const cur = demoPaths(appId);
  if (!fs.existsSync(cur.video)) return { current: 0, versions: [], notes: [] };
  const v1 = demoPaths(appId, versionTake(1));
  for (const k of ["scene", "poster", "video"] as const) {
    if (fs.existsSync(cur[k])) fs.copyFileSync(cur[k], v1[k]);
  }
  const m: DemoManifest = {
    current: 1,
    versions: [{ v: 1, createdAt: fs.statSync(cur.video).mtimeMs, kind: "create" }],
    notes: [],
  };
  writeManifest(appId, m);
  return m;
}

function writeManifest(appId: string, m: DemoManifest): void {
  fs.mkdirSync(demoDir(), { recursive: true });
  const tmp = `${manifestPath(appId)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
  fs.renameSync(tmp, manifestPath(appId));
}

/** Copy one version over the "in use" files (video last: it marks a finished video). */
function useVersionFiles(appId: string, v: number): void {
  const from = demoPaths(appId, versionTake(v));
  const to = demoPaths(appId);
  for (const k of ["scene", "poster", "video"] as const) {
    if (!fs.existsSync(from[k])) continue;
    const tmp = `${to[k]}.tmp`;
    fs.copyFileSync(from[k], tmp);
    fs.renameSync(tmp, to[k]);
  }
}

/** Keep a finished take as the next version and start using it. Returns the version. */
export function addVersion(
  appId: string,
  take: string,
  kind: DemoVersion["kind"],
  fixedNoteIds: string[] = [],
  scores?: { fidelity: number; polish: number },
): number {
  const m = readManifest(appId);
  const v = Math.max(0, ...m.versions.map((x) => x.v)) + 1;
  const from = demoPaths(appId, take);
  const to = demoPaths(appId, versionTake(v));
  for (const k of ["scene", "poster", "video"] as const) fs.renameSync(from[k], to[k]);
  m.versions.push({
    v,
    createdAt: Date.now(),
    kind,
    ...(fixedNoteIds.length ? { notes: fixedNoteIds.length } : {}),
    ...(scores ?? {}),
  });
  const fixed = new Set(fixedNoteIds);
  for (const n of m.notes) if (fixed.has(n.id) && !n.fixedIn) n.fixedIn = v;
  m.current = v;
  useVersionFiles(appId, v);
  prune(appId, m);
  writeManifest(appId, m);
  return v;
}

function prune(appId: string, m: DemoManifest): void {
  while (m.versions.length > MAX_VERSIONS) {
    const i = m.versions.findIndex((x) => x.v !== m.current);
    if (i < 0) return;
    const [old] = m.versions.splice(i, 1);
    for (const f of Object.values(demoPaths(appId, versionTake(old!.v)))) fs.rmSync(f, { force: true });
  }
}

export function setCurrentVersion(appId: string, v: number): DemoManifest {
  const m = readManifest(appId);
  if (!m.versions.some((x) => x.v === v)) throw new Error("No such version");
  m.current = v;
  useVersionFiles(appId, v);
  writeManifest(appId, m);
  return m;
}

const unit = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined);

export function addNote(appId: string, input: { t?: unknown; x?: unknown; y?: unknown; body?: unknown }): DemoNote {
  const body = typeof input.body === "string" ? input.body.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (!body) throw new Error("Write what should change.");
  const m = readManifest(appId);
  if (!m.current) throw new Error("Make the preview video first.");
  const t = typeof input.t === "number" && Number.isFinite(input.t) ? Math.max(0, Math.round(input.t * 10) / 10) : 0;
  const x = unit(input.x);
  const y = unit(input.y);
  const note: DemoNote = {
    id: randomUUID(),
    v: m.current,
    t,
    ...(x !== undefined && y !== undefined ? { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } : {}),
    body,
    createdAt: Date.now(),
  };
  m.notes.push(note);
  writeManifest(appId, m);
  return note;
}

/** Delete an open note (fixed notes are history). */
export function deleteNote(appId: string, id: string): boolean {
  const m = readManifest(appId);
  const i = m.notes.findIndex((n) => n.id === id && !n.fixedIn);
  if (i < 0) return false;
  m.notes.splice(i, 1);
  writeManifest(appId, m);
  return true;
}

export function openNotes(appId: string): DemoNote[] {
  return readManifest(appId).notes.filter((n) => !n.fixedIn).sort((a, b) => a.t - b.t);
}
