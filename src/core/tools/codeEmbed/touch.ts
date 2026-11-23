/**
 * Index an app or job when any agent tool touches it, not only a bash grep: read_app_file, edit_file, list_app_files,
 * search_app_files, read_job_file, read_file on a path under apps/ or Jobs/, … Also: which apps to index in the
 * background at startup (opened in the last N days).
 *
 * Touching only adopts the root (a cheap manifest scan, deferred off the tool's path); embedding runs in the
 * background behind the usual pause rules. Nothing here can delay or fail a tool call.
 */
import * as fs from "fs";
import * as path from "path";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROJECT_IN_PATH =
  /(?:^|[/\\])(apps|Jobs|jobs)[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/\\\s"']|$)/gi;
/** Arguments that name an app/job by id. */
const ID_KEYS = ["appId", "projectId", "jobId", "installedAppId"];
/** Arguments that hold a path (never file contents: content/newString/oldString are not scanned). */
const PATH_KEYS = [
  "path",
  "filePath",
  "cwd",
  "dir",
  "directory",
  "root",
  "command",
  "filename",
];
const MAX_ROOTS_PER_CALL = 3;

export interface TouchTarget {
  kind: "project" | "path";
  /** Absolute root (apps/<id> or Jobs/<id>) for project; an absolute path for path (a git repo is looked up later). */
  value: string;
}

/** App/job roots (and absolute paths, for git repos) a tool call names. Never throws. */
export function touchTargetsFromArgs(
  args: unknown,
  paprRoot: string,
): TouchTarget[] {
  const out = new Map<string, TouchTarget>();
  const a = (
    args && typeof args === "object"
      ? ((args as { context?: unknown }).context ?? args)
      : null
  ) as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return [];
  const apps = path.join(paprRoot, "apps");
  const jobs = path.join(paprRoot, "Jobs");
  const addProject = (id: string, prefer?: "apps" | "jobs") => {
    const cands = prefer === "jobs" ? [jobs, apps] : [apps, jobs];
    const root = cands
      .map((d) => path.join(d, id))
      .find((r) => fs.existsSync(r));
    if (root) out.set(root, { kind: "project", value: root });
  };
  for (const k of ID_KEYS) {
    const v = a[k];
    if (typeof v === "string" && UUID.test(v) && v.trim().length === 36)
      addProject(v.trim().toLowerCase(), k === "jobId" ? "jobs" : undefined);
  }
  for (const k of PATH_KEYS) {
    const v = a[k];
    if (typeof v !== "string" || !v || v.length > 4000) continue;
    for (const m of v.matchAll(PROJECT_IN_PATH))
      addProject(m[2]!.toLowerCase(), /^jobs$/i.test(m[1]!) ? "jobs" : "apps");
    if (
      k !== "command" &&
      k !== "filename" &&
      (path.isAbsolute(v) || v.startsWith("~/"))
    )
      out.set(`p:${v}`, { kind: "path", value: v });
  }
  return [...out.values()].slice(0, MAX_ROOTS_PER_CALL);
}

type ToolLike = {
  execute?: (input: unknown, ctx?: unknown) => Promise<unknown>;
} & Record<string, unknown>;

/**
 * Wrap tools so that after each call the app/job/repo it touched is adopted by the on-device index. The tool's
 * result is returned unchanged and first; adoption is fire-and-forget.
 */
export function wrapToolsWithIndexOnTouch<T extends Record<string, ToolLike>>(
  tools: T,
  note: (targets: TouchTarget[]) => void,
  paprRoot: () => string | undefined,
): T {
  if (
    process.env.PAPR_CODE_EMBED === "0" ||
    process.env.PAPR_CODE_EMBED_TOUCH === "0"
  )
    return tools;
  const wrapped: Record<string, ToolLike> = {};
  for (const [id, tool] of Object.entries(tools)) {
    const exec = tool?.execute?.bind(tool);
    if (!exec) {
      wrapped[id] = tool;
      continue;
    }
    wrapped[id] = {
      ...tool,
      execute: async (input: unknown, ctx?: unknown) => {
        const result = await exec(input, ctx);
        try {
          const root = paprRoot();
          if (root) {
            const t = touchTargetsFromArgs(input, root);
            if (t.length) note(t);
          }
        } catch {}
        return result;
      },
    };
  }
  return wrapped as T;
}

/** apps/<id> roots opened (or updated) in the last `days`, most recent first, at most `cap`. [] on any error. */
export function recentAppRoots(
  paprRoot: string,
  days: number,
  cap: number,
  now = Date.now(),
): string[] {
  if (days <= 0 || cap <= 0) return [];
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(paprRoot, "data", "apps.json"), "utf8"),
    );
    const list: Array<{
      id?: string;
      lastOpenedAt?: string;
      updatedAt?: string;
    }> = Array.isArray(raw) ? raw : (raw?.apps ?? []);
    const since = now - days * 86_400_000;
    return list
      .map((a) => ({
        id: a.id,
        at: Date.parse(a.lastOpenedAt ?? a.updatedAt ?? ""),
      }))
      .filter(
        (a) =>
          a.id && UUID.test(a.id) && Number.isFinite(a.at) && a.at >= since,
      )
      .sort((x, y) => y.at - x.at)
      .map((a) => path.join(paprRoot, "apps", a.id!))
      .filter((r) => fs.existsSync(r))
      .slice(0, cap);
  } catch {
    return [];
  }
}

/** Days of app history to index in the background (PAPR_CODE_EMBED_RECENT_DAYS, default 30; 0 = off). */
export function recentDays(): number {
  const v = Number(process.env.PAPR_CODE_EMBED_RECENT_DAYS ?? 30);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

export const RECENT_APPS_CAP = 50;
