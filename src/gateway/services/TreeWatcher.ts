/**
 * TreeWatcher — one OS-level recursive watch per root instead of one fd per file.
 *
 * Why this exists: chokidar ≥4 dropped fsevents and falls back to `fs.watch`
 * on every file and directory (one kqueue fd each). A workspace with a few
 * thousand app/job/workspace files pushes the gateway's *highest fd number*
 * past OPEN_MAX (10240, compile-time in macOS libc). libuv spawns children via
 * `posix_spawn`, whose file-action calls reject any fd ≥ OPEN_MAX with EBADF —
 * regardless of `ulimit -n`. Result: "spawn EBADF" on bash, jobs, esbuild,
 * Playwright, venv creation. See tests/tree-watcher.test.ts and the EBADF
 * regression test for the reproduction.
 *
 * Native `fs.watch(root, { recursive: true })` uses FSEvents on macOS,
 * ReadDirectoryChangesW on Windows, and inotify (Node ≥20) on Linux — a
 * constant number of fds per root.
 *
 * Semantics preserved from the chokidar consumers:
 * - `add` / `change` / `unlink` per file (directories are not reported)
 * - `settleMs` ≈ chokidar `awaitWriteFinish.stabilityThreshold`: an event is
 *   only delivered after the path has been quiet for that long
 * - `ignore(absPath)` predicate evaluated before any stat/timers
 */

import { watch as fsWatch, type FSWatcher as NodeFSWatcher } from "fs";
import { stat } from "fs/promises";
import path from "path";

export type TreeWatchEventType = "add" | "change" | "unlink";

export interface TreeWatchEvent {
  type: TreeWatchEventType;
  /** Absolute, normalized path. */
  path: string;
  /** Root the event was observed under. */
  root: string;
}

export interface TreeWatcherOptions {
  roots: string[];
  /** Default true. Non-recursive = only direct children (chokidar depth: 0). */
  recursive?: boolean;
  /** Quiet period before an event is delivered (default 200ms). */
  settleMs?: number;
  ignore?: (absPath: string) => boolean;
  onEvent: (event: TreeWatchEvent) => void;
  onError?: (error: Error, root: string) => void;
}

interface PendingChange {
  timer: NodeJS.Timeout;
  root: string;
  sawRename: boolean;
}

export class TreeWatcher {
  private readonly watchers = new Map<string, NodeFSWatcher>();
  private readonly pending = new Map<string, PendingChange>();
  private readonly settleMs: number;
  private readonly recursive: boolean;
  private closed = false;

  constructor(private readonly options: TreeWatcherOptions) {
    this.settleMs = Math.max(0, options.settleMs ?? 200);
    this.recursive = options.recursive ?? true;
    for (const root of options.roots) {
      this.addRoot(root);
    }
  }

  /** Number of OS watch handles (== roots successfully watched). */
  get rootCount(): number {
    return this.watchers.size;
  }

  hasRoot(root: string): boolean {
    return this.watchers.has(path.resolve(root));
  }

  /** Idempotent. Roots that do not exist are reported via onError and skipped. */
  addRoot(root: string): boolean {
    if (this.closed) return false;
    const abs = path.resolve(root);
    if (this.watchers.has(abs)) return true;

    let watcher: NodeFSWatcher;
    try {
      watcher = fsWatch(abs, { persistent: true, recursive: this.recursive }, (eventType, filename) =>
        this.onRawEvent(abs, eventType, filename),
      );
    } catch (error) {
      this.options.onError?.(error as Error, abs);
      return false;
    }

    watcher.on("error", (error) => {
      this.options.onError?.(error as Error, abs);
      // A watcher that errored is dead; drop it so rootCount stays truthful.
      this.watchers.delete(abs);
    });

    this.watchers.set(abs, watcher);
    return true;
  }

  removeRoot(root: string): void {
    const abs = path.resolve(root);
    const watcher = this.watchers.get(abs);
    if (watcher) {
      watcher.close();
      this.watchers.delete(abs);
    }
    for (const [p, entry] of this.pending) {
      if (entry.root === abs) {
        clearTimeout(entry.timer);
        this.pending.delete(p);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private onRawEvent(
    root: string,
    eventType: string,
    filename: string | Buffer | null,
  ): void {
    if (this.closed || filename === null || filename === undefined) {
      // FSEvents can coalesce into a null filename under heavy churn. There is
      // no path to route, and every consumer keys on path — drop it.
      return;
    }
    const rel = typeof filename === "string" ? filename : filename.toString("utf8");
    if (!rel) return;
    // FSEvents reports a change to the root directory itself as
    // `<basename(root)>` — i.e. "apps" under ".../apps" — which resolves to a
    // path that never existed. Drop it rather than emit a phantom unlink.
    if (rel === path.basename(root) && !rel.includes(path.sep)) {
      return;
    }
    const abs = path.normalize(path.join(root, rel));

    if (this.options.ignore?.(abs)) {
      return;
    }

    const existing = this.pending.get(abs);
    if (existing) {
      clearTimeout(existing.timer);
      existing.sawRename ||= eventType === "rename";
      existing.timer = this.armTimer(abs);
      return;
    }

    this.pending.set(abs, {
      timer: this.armTimer(abs),
      root,
      sawRename: eventType === "rename",
    });
  }

  private armTimer(abs: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.flush(abs), this.settleMs);
    timer.unref?.();
    return timer;
  }

  private async flush(abs: string): Promise<void> {
    const entry = this.pending.get(abs);
    if (!entry) return;
    this.pending.delete(abs);
    if (this.closed) return;

    let type: TreeWatchEventType;
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        return; // directories are never reported (matches chokidar add/change/unlink)
      }
      // Creation and atomic write-then-rename both surface as "rename".
      type = entry.sawRename ? "add" : "change";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onError?.(error as Error, entry.root);
        return;
      }
      // A path that vanished without ever being renamed/created is a
      // directory-attribute echo, not a file deletion.
      if (!entry.sawRename) {
        return;
      }
      type = "unlink";
    }

    if (this.closed) return;
    try {
      this.options.onEvent({ type, path: abs, root: entry.root });
    } catch (error) {
      this.options.onError?.(error as Error, entry.root);
    }
  }
}
