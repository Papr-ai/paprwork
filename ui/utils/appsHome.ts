/**
 * My apps home: the user's own arrangement of apps and collections (iOS Home
 * Screen model). Pure helpers, no React, so the drag/drop rules are unit-tested.
 *
 * - `order` is the top level: app ids and collection ids ("f:…"), in place.
 * - A collection holds app ids. Collections never nest.
 * - A collection left with one app dissolves into that app, in the same spot.
 * - First run seeds collections from Jev categories with 3+ apps; nothing is
 *   saved until the user moves something, so later category passes still count.
 */
export interface HomeFolder {
  name: string;
  ids: string[];
}
export interface HomeLayout {
  order: string[];
  folders: Record<string, HomeFolder>;
}
export type DropZone = "before" | "after" | "into";

export const FOLDER_PREFIX = "f:";
export const isFolderId = (id: string): boolean => id.startsWith(FOLDER_PREFIX);

export function cloneLayout(l: HomeLayout): HomeLayout {
  return {
    order: [...l.order],
    folders: Object.fromEntries(
      Object.entries(l.folders).map(([k, f]) => [k, { name: f.name, ids: [...f.ids] }]),
    ),
  };
}

export function folderOf(l: HomeLayout, id: string): string | undefined {
  return Object.keys(l.folders).find((k) => l.folders[k]!.ids.includes(id));
}

export function detach(l: HomeLayout, id: string): void {
  l.order = l.order.filter((x) => x !== id);
  for (const f of Object.values(l.folders)) f.ids = f.ids.filter((x) => x !== id);
}

/** A collection with one app left becomes that app, in the same spot. Empty ones go. */
export function prune(l: HomeLayout): void {
  for (const [k, f] of Object.entries(l.folders)) {
    if (f.ids.length > 1) continue;
    const i = l.order.indexOf(k);
    if (f.ids.length === 1 && i >= 0) l.order.splice(i, 1, f.ids[0]!);
    else l.order = l.order.filter((x) => x !== k);
    delete l.folders[k];
  }
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
}

export function uniqueFolderId(l: HomeLayout, name: string): string {
  const base = `${FOLDER_PREFIX}${slug(name)}`;
  let id = base;
  for (let n = 2; l.folders[id]; n += 1) id = `${base}-${n}`;
  return id;
}

/** First run: categories with `minSize`+ apps become collections, the rest stay loose. */
export function seedLayout(
  appIds: readonly string[],
  categoryOf: (id: string) => string | null,
  minSize = 3,
): HomeLayout {
  const count = new Map<string, number>();
  for (const id of appIds) {
    const c = categoryOf(id);
    if (c && c !== "Other") count.set(c, (count.get(c) ?? 0) + 1);
  }
  const l: HomeLayout = { order: [], folders: {} };
  const byName = new Map<string, string>();
  for (const id of appIds) {
    const c = categoryOf(id);
    if (!c || c === "Other" || (count.get(c) ?? 0) < minSize) {
      l.order.push(id);
      continue;
    }
    let fid = byName.get(c);
    if (!fid) {
      fid = uniqueFolderId(l, c);
      byName.set(c, fid);
      l.folders[fid] = { name: c, ids: [] };
      l.order.push(fid);
    }
    l.folders[fid]!.ids.push(id);
  }
  return l;
}

/**
 * Fit a saved layout to the apps that exist now: drop removed/archived ones,
 * put apps the layout has never seen at the front (shown as "New").
 */
export function reconcileLayout(
  saved: HomeLayout,
  appIds: readonly string[],
): { layout: HomeLayout; added: string[] } {
  const present = new Set(appIds);
  const l = cloneLayout(saved);
  l.order = l.order.filter((id) => (isFolderId(id) ? Boolean(l.folders[id]) : present.has(id)));
  for (const k of Object.keys(l.folders)) {
    if (!l.order.includes(k)) delete l.folders[k];
    else l.folders[k]!.ids = l.folders[k]!.ids.filter((id) => present.has(id));
  }
  prune(l);
  const placed = new Set([...l.order, ...Object.values(l.folders).flatMap((f) => f.ids)]);
  const added = appIds.filter((id) => !placed.has(id));
  l.order = [...added, ...l.order];
  return { layout: l, added };
}

/**
 * Drop `dragId` on `targetId`. "into" an app makes a new collection (returned as
 * `created` so the UI can open it for naming); "into" a collection files it.
 */
export function dropOnItem(
  saved: HomeLayout,
  dragId: string,
  targetId: string,
  zone: DropZone,
  newFolderName = "New collection",
): { layout: HomeLayout; created: string | null } {
  if (dragId === targetId) return { layout: saved, created: null };
  const l = cloneLayout(saved);
  let created: string | null = null;
  if (zone === "into" && !isFolderId(dragId)) {
    const host = isFolderId(targetId) ? targetId : folderOf(l, targetId);
    detach(l, dragId);
    if (host && l.folders[host]) {
      l.folders[host]!.ids.push(dragId);
    } else {
      const at = l.order.indexOf(targetId);
      if (at < 0) return { layout: saved, created: null };
      created = uniqueFolderId(l, newFolderName);
      l.folders[created] = { name: newFolderName, ids: [targetId, dragId] };
      l.order[at] = created;
    }
  } else {
    const host = folderOf(l, targetId);
    if (host && isFolderId(dragId)) return { layout: saved, created: null };
    detach(l, dragId);
    const arr = host ? l.folders[host]!.ids : l.order;
    const i = arr.indexOf(targetId);
    if (i < 0) return { layout: saved, created: null };
    arr.splice(zone === "after" ? i + 1 : i, 0, dragId);
  }
  prune(l);
  return { layout: l, created };
}

/** Take an item out (to the end of the top level), e.g. dragged out of a collection. */
export function moveToTopLevel(saved: HomeLayout, id: string): HomeLayout {
  const l = cloneLayout(saved);
  detach(l, id);
  l.order.push(id);
  prune(l);
  return l;
}

export function moveIntoFolder(saved: HomeLayout, id: string, fid: string): HomeLayout {
  if (isFolderId(id) || !saved.folders[fid]) return saved;
  const l = cloneLayout(saved);
  detach(l, id);
  l.folders[fid]!.ids.unshift(id);
  prune(l);
  return l;
}

/** Dissolve a collection: its apps take its place, in order. */
export function ungroupFolder(saved: HomeLayout, fid: string): HomeLayout {
  const f = saved.folders[fid];
  if (!f) return saved;
  const l = cloneLayout(saved);
  const at = l.order.indexOf(fid);
  l.order.splice(at < 0 ? l.order.length : at, at < 0 ? 0 : 1, ...f.ids);
  delete l.folders[fid];
  return l;
}

/** Remove ids from a layout (used to keep not-yet-seen apps "New" after a save). */
export function withoutIds(saved: HomeLayout, ids: readonly string[]): HomeLayout {
  if (ids.length === 0) return saved;
  const l = cloneLayout(saved);
  for (const id of ids) detach(l, id);
  prune(l);
  return l;
}

/**
 * File an app into the collection for `category`, creating it from the loose
 * apps of that category if needed. Returns null when there is nothing to join
 * (a one-app collection would dissolve straight away).
 */
export function fileIntoCategory(
  saved: HomeLayout,
  id: string,
  category: string,
  categoryOf: (id: string) => string | null,
): HomeLayout | null {
  const l = cloneLayout(saved);
  let fid = Object.keys(l.folders).find((k) => l.folders[k]!.name === category);
  detach(l, id);
  if (!fid) {
    const loose = l.order.filter((x) => !isFolderId(x) && categoryOf(x) === category);
    if (loose.length === 0) return null;
    const at = l.order.indexOf(loose[0]!);
    for (const x of loose) detach(l, x);
    fid = uniqueFolderId(l, category);
    l.folders[fid] = { name: category, ids: loose };
    l.order.splice(at < 0 ? 0 : at, 0, fid);
  }
  l.folders[fid]!.ids.unshift(id);
  prune(l);
  return l;
}

/** Category the "Move to …" shortcut can offer for a new app, if any. */
export function fileTargetFor(
  l: HomeLayout,
  id: string,
  categoryOf: (id: string) => string | null,
): string | null {
  const c = categoryOf(id);
  if (!c || c === "Other") return null;
  if (Object.values(l.folders).some((f) => f.name === c)) return c;
  return l.order.some((x) => x !== id && !isFolderId(x) && categoryOf(x) === c) ? c : null;
}

export function renameFolder(saved: HomeLayout, fid: string, name: string): HomeLayout {
  const trimmed = name.trim();
  if (!trimmed || !saved.folders[fid]) return saved;
  const l = cloneLayout(saved);
  l.folders[fid]!.name = trimmed;
  return l;
}

/** Banner shade 0–5 (Papr blue → indigo). Stable per id, no user input. */
export function bannerShade(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

export function relativeWhen(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (days === 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(iso).toLocaleDateString();
}

function isLayout(v: unknown): v is HomeLayout {
  if (!v || typeof v !== "object") return false;
  const l = v as HomeLayout;
  return (
    Array.isArray(l.order) &&
    l.order.every((x) => typeof x === "string") &&
    !!l.folders &&
    typeof l.folders === "object" &&
    Object.values(l.folders).every(
      (f) => f && typeof f.name === "string" && Array.isArray(f.ids),
    )
  );
}

export function loadHomeLayout(key: string): HomeLayout | null {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveHomeLayout(key: string, l: HomeLayout): void {
  try {
    localStorage.setItem(key, JSON.stringify(l));
  } catch {
    // Storage full or blocked: the arrangement just won't persist.
  }
}
