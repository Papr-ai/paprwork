/**
 * Notification settings, per source (Settings → Notifications). Shared by the gateway and the UI.
 * Stored sparse: only what you changed. Everything else follows the defaults, so a better default
 * reaches everyone who never touched it, and Reset just deletes your changes.
 *
 * Per source: allow, sound for its desktop notifications, and for each kind (waiting on you / done)
 * where it appears. Per type: on/off.
 * Settings only ever take things away (no desktop, no dot, kept inside); they never raise a level.
 */
export type Surface = "desktop" | "badge";
export const SURFACES: Surface[] = ["desktop", "badge"];
export type Where = Record<Surface, boolean>;
export interface SourcePref { allow: boolean; sound: boolean; needs: Where; done: Where }
export interface SourcePrefPatch { allow?: boolean; sound?: boolean; needs?: Partial<Where>; done?: Partial<Where> }
export interface NoticePrefs {
  version: 2;
  sources: Record<string, SourcePrefPatch>;
  /** "source/type" → false when that type is off. */
  types: Record<string, boolean>;
  /** Do Not Disturb: no desktop notifications until this time (ISO). Urgent still comes through. */
  pauseUntil?: string;
}

const BASE: SourcePref = { allow: true, sound: true, needs: { desktop: true, badge: true }, done: { desktop: false, badge: true } };
/** Finished replies pop while you're away (same as before Stage 2). */
const SOURCE_DEFAULTS: Record<string, SourcePrefPatch> = { chats: { done: { desktop: true } } };

export const DEFAULT_NOTICE_PREFS: NoticePrefs = { version: 2, sources: {}, types: {} };

export function defaultSourcePref(id: string): SourcePref {
  const d = SOURCE_DEFAULTS[id] ?? {};
  return { allow: d.allow ?? BASE.allow, sound: d.sound ?? BASE.sound, needs: { ...BASE.needs, ...d.needs }, done: { ...BASE.done, ...d.done } };
}

export function sourcePref(p: NoticePrefs, id: string): SourcePref {
  const d = defaultSourcePref(id), u = p.sources[id] ?? {};
  return { allow: u.allow ?? d.allow, sound: u.sound ?? d.sound, needs: { ...d.needs, ...u.needs }, done: { ...d.done, ...u.done } };
}

export const typeKey = (source: string, type: string) => `${source}/${type}`;
export const typeOn = (p: NoticePrefs, source: string, type: string) => p.types[typeKey(source, type)] !== false;

/** Paused right now (Do Not Disturb set in Papr Work). */
export const pausedAt = (p: NoticePrefs, now = Date.now()) => !!p.pauseUntil && Date.parse(p.pauseUntil) > now;
const cleanPause = (v: unknown, now = Date.now()) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && Date.parse(v) > now ? new Date(Date.parse(v)).toISOString() : undefined;

const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
function cleanWhere(raw: unknown): Partial<Where> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>, out: Partial<Where> = {};
  for (const s of SURFACES) if (bool(r[s]) !== undefined) out[s] = r[s] as boolean;
  return Object.keys(out).length ? out : undefined;
}

/** Stage 1 (#711) saved priorityOs / chatDoneOs / apps. Carry the intent over once. */
function fromV1(r: Record<string, unknown>): NoticePrefs {
  const p: NoticePrefs = { version: 2, sources: {}, types: {} };
  const put = (id: string, patch: SourcePrefPatch) => {
    const cur = p.sources[id] ?? {};
    p.sources[id] = { ...cur, ...patch, needs: { ...cur.needs, ...patch.needs }, done: { ...cur.done, ...patch.done } };
  };
  if (r.priorityOs === false) for (const id of ["chats", "apps", "account", "updates"]) put(id, { needs: { desktop: false } });
  if (r.chatDoneOs === false) put("chats", { done: { desktop: false } });
  for (const [id, v] of Object.entries((r.apps ?? {}) as Record<string, unknown>)) {
    if (v === "off") put(`app:${id}`, { allow: false });
    else if (r.priorityOs === false) put(`app:${id}`, { needs: { desktop: false } });
  }
  return p;
}

/** Only known fields with the right types survive; a bad write can't break routing. */
export function cleanPrefs(raw: unknown): NoticePrefs {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.version !== 2) return compactPrefs(fromV1(r));
  const out: NoticePrefs = { version: 2, sources: {}, types: {} };
  for (const [id, v] of Object.entries((r.sources ?? {}) as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>, patch: SourcePrefPatch = {};
    if (bool(s.allow) !== undefined) patch.allow = s.allow as boolean;
    if (bool(s.sound) !== undefined) patch.sound = s.sound as boolean;
    const needs = cleanWhere(s.needs), done = cleanWhere(s.done);
    if (needs) patch.needs = needs;
    if (done) patch.done = done;
    out.sources[id] = patch;
  }
  for (const [k, v] of Object.entries((r.types ?? {}) as Record<string, unknown>)) if (k.includes("/") && v === false) out.types[k] = false;
  const pause = cleanPause(r.pauseUntil);
  if (pause) out.pauseUntil = pause;
  return compactPrefs(out);
}

/** Drop anything equal to its default, so it follows future defaults. */
export function compactPrefs(p: NoticePrefs): NoticePrefs {
  const sources: Record<string, SourcePrefPatch> = {};
  for (const [id, s] of Object.entries(p.sources)) {
    const d = defaultSourcePref(id), patch: SourcePrefPatch = {};
    if (s.allow !== undefined && s.allow !== d.allow) patch.allow = s.allow;
    if (s.sound !== undefined && s.sound !== d.sound) patch.sound = s.sound;
    for (const cat of ["needs", "done"] as const) {
      const w: Partial<Where> = {};
      for (const k of SURFACES) if (s[cat]?.[k] !== undefined && s[cat]![k] !== d[cat][k]) w[k] = s[cat]![k];
      if (Object.keys(w).length) patch[cat] = w;
    }
    if (Object.keys(patch).length) sources[id] = patch;
  }
  const types = Object.fromEntries(Object.entries(p.types).filter(([, v]) => v === false));
  const pause = cleanPause(p.pauseUntil);
  return { version: 2, sources, types, ...(pause ? { pauseUntil: pause } : {}) };
}

/** Apply a change from Settings on top of what you already changed. Junk is ignored. */
export function mergePrefs(cur: NoticePrefs, patch: unknown): NoticePrefs {
  const r = (patch ?? {}) as Record<string, unknown>;
  const sources = { ...cur.sources };
  for (const [id, v] of Object.entries((r.sources ?? {}) as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const raw = v as Record<string, unknown>, c: SourcePrefPatch = { ...sources[id] };
    if (typeof raw.allow === "boolean") c.allow = raw.allow;
    if (typeof raw.sound === "boolean") c.sound = raw.sound;
    for (const cat of ["needs", "done"] as const) {
      const w = cleanWhere(raw[cat]);
      if (w) c[cat] = { ...c[cat], ...w };
    }
    sources[id] = c;
  }
  const types = { ...cur.types };
  for (const [k, v] of Object.entries((r.types ?? {}) as Record<string, unknown>)) {
    if (!k.includes("/") || typeof v !== "boolean") continue;
    if (v) delete types[k]; else types[k] = false;
  }
  // pauseUntil: a time pauses desktop notifications until then; null resumes.
  const pauseUntil = "pauseUntil" in r ? (r.pauseUntil === null ? undefined : cleanPause(r.pauseUntil) ?? cur.pauseUntil) : cur.pauseUntil;
  return compactPrefs({ version: 2, sources, types, ...(pauseUntil ? { pauseUntil } : {}) });
}
