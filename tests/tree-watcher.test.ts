import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs, readdirSync } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { TreeWatcher, type TreeWatchEvent } from "../src/gateway/services/TreeWatcher.js";

function openFdCount(): number | null {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("TreeWatcher", () => {
  let root: string;
  let events: TreeWatchEvent[];
  let watcher: TreeWatcher | null;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `tree-watcher-${process.pid}-${randomUUID()}`);
    await fs.mkdir(path.join(root, "apps", "a1", "nested"), { recursive: true });
    await fs.mkdir(path.join(root, "apps", "a2"), { recursive: true });
    events = [];
    watcher = null;
  });

  afterEach(async () => {
    await watcher?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test("uses a constant number of fds regardless of tree size", async () => {
    // Pre-populate a tree big enough that per-file watching would be obvious.
    for (let i = 0; i < 300; i++) {
      await fs.writeFile(path.join(root, "apps", "a1", `f${i}.ts`), "x");
    }
    const before = openFdCount();
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps")],
      settleMs: 50,
      onEvent: (e) => events.push(e),
    });
    const after = openFdCount();
    expect(watcher.rootCount).toBe(1);
    if (before !== null && after !== null) {
      // FSEvents/inotify: a handful of fds, never one per file.
      expect(after - before).toBeLessThan(10);
    }
  });

  test("reports add, change, unlink for files in nested dirs (recursive)", async () => {
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps")],
      settleMs: 50,
      onEvent: (e) => events.push(e),
    });
    // FSEvents needs a beat to arm on macOS.
    await new Promise((r) => setTimeout(r, 150));

    const target = path.join(root, "apps", "a1", "nested", "app.ts");
    await fs.writeFile(target, "one");
    await waitFor(() => events.some((e) => e.path === target && e.type === "add"));

    await new Promise((r) => setTimeout(r, 120));
    await fs.writeFile(target, "two");
    await waitFor(() =>
      events.some((e) => e.path === target && (e.type === "change" || e.type === "add")),
    );

    await new Promise((r) => setTimeout(r, 120));
    await fs.rm(target);
    await waitFor(() => events.some((e) => e.path === target && e.type === "unlink"));

    for (const e of events) {
      expect(e.root).toBe(path.join(root, "apps"));
    }
  });

  test("coalesces a burst of writes into one event after settle", async () => {
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps")],
      settleMs: 150,
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 150));

    const target = path.join(root, "apps", "a2", "burst.ts");
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(target, `v${i}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    await waitFor(() => events.some((e) => e.path === target));
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e.path === target)).toHaveLength(1);
  });

  test("ignore predicate suppresses events and directories are never reported", async () => {
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps")],
      settleMs: 50,
      ignore: (p) => p.includes(`${path.sep}dist${path.sep}`),
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 150));

    await fs.mkdir(path.join(root, "apps", "a1", "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "apps", "a1", "dist", "app.js"), "built");
    await fs.mkdir(path.join(root, "apps", "a1", "newdir"), { recursive: true });
    const kept = path.join(root, "apps", "a1", "kept.ts");
    await fs.writeFile(kept, "k");

    await waitFor(() => events.some((e) => e.path === kept));
    await new Promise((r) => setTimeout(r, 200));
    // Under load a write can surface as add + a later change; what matters is
    // that nothing under dist/ and no directory ever reaches the consumer.
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.path))).toEqual(new Set([kept]));
  });

  test("non-recursive roots only see direct children", async () => {
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps", "a1")],
      recursive: false,
      settleMs: 50,
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 150));

    await fs.writeFile(path.join(root, "apps", "a1", "nested", "deep.ts"), "d");
    const direct = path.join(root, "apps", "a1", "data.db");
    await fs.writeFile(direct, "sqlite");

    await waitFor(() => events.some((e) => e.path === direct));
    await new Promise((r) => setTimeout(r, 200));
    expect(events.every((e) => path.dirname(e.path) === path.join(root, "apps", "a1"))).toBe(true);
  });

  test("addRoot is idempotent and missing roots are reported, not thrown", async () => {
    const errors: string[] = [];
    watcher = new TreeWatcher({
      roots: [path.join(root, "apps"), path.join(root, "does-not-exist")],
      settleMs: 50,
      onEvent: (e) => events.push(e),
      onError: (_e, r) => errors.push(r),
    });
    expect(watcher.rootCount).toBe(1);
    expect(errors).toEqual([path.join(root, "does-not-exist")]);
    expect(watcher.addRoot(path.join(root, "apps"))).toBe(true);
    expect(watcher.rootCount).toBe(1);
    watcher.removeRoot(path.join(root, "apps"));
    expect(watcher.rootCount).toBe(0);
  });
});
