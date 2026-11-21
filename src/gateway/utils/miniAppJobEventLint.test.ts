import { describe, expect, it } from "vitest";
import { checkMiniAppJobEventPatterns } from "./miniAppJobEventLint.js";

const SDK = "import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';\n";
const run = (files: Record<string, string>) => checkMiniAppJobEventPatterns(new Map(Object.entries(files)));
const rules = (files: Record<string, string>) => run(files).map((i) => i.rule);

describe("miniAppJobEventLint (#957)", () => {
  it("flags setInterval on a backend action even when the file imports the job-events SDK", () => {
    const r = rules({
      "app.ts": SDK + "subscribeJobEvents({ dbIds: ['db-1'], onDbChanged: load });\n" +
        "async function usage() { await fetch('/api/app/backend/usage', { method: 'POST' }); }\n" +
        "setInterval(usage, 60000);\n",
    });
    expect(r).toContain("no-db-polling");
  });

  it("follows helpers across files", () => {
    const r = rules({
      "api.ts": "export const api = (a: string) => fetch(`/api/app/backend/${a}`, { method: 'POST' });\n",
      "meter.ts": SDK + "import { api } from './api';\nfunction refresh() { void api('usage'); }\nwindow.setInterval(() => { refresh(); }, 60_000);\n",
    });
    expect(r).toContain("no-db-polling");
  });

  it("flags a function that retries itself immediately from its error handler", () => {
    const r = run({
      "app.ts": "async function usage() {\n  try { await fetch('/api/app/backend/usage'); }\n  catch { usage(); }\n}\n",
    });
    expect(r.map((i) => i.message).join()).toMatch(/Retry flood/);
  });

  it("flags short setTimeout retries on error but allows backoff", () => {
    expect(rules({
      "a.ts": "async function load() { try { await fetch('/api/db/query'); } catch { setTimeout(load, 1000); } }\n",
    })).toContain("no-db-polling");
    expect(rules({
      "a.ts": "let n = 0;\nasync function load() { try { await fetch('/api/db/query'); } catch { if (++n < 5) setTimeout(load, 2000 * n); } }\n",
    })).not.toContain("no-db-polling");
  });

  it("flags self-rescheduling setTimeout polling and sleep loops", () => {
    expect(rules({ "a.ts": "function tick() { fetch('/api/db/query'); setTimeout(tick, 3000); }\n" })).toContain("no-db-polling");
    expect(rules({
      "a.ts": "async function wait() { while (true) { await fetch('/api/jobs/status?id=1'); await new Promise((r) => setTimeout(r, 2000)); } }\n",
    })).toContain("no-db-polling");
  });

  it("does not flag UI timers or event-driven refresh", () => {
    expect(rules({
      "a.ts": SDK + "async function load() { await fetch('/api/db/query', { method: 'POST' }); }\n" +
        "subscribeJobEvents({ dbIds: ['db-1'], onDbChanged: () => load() });\n" +
        "let secs = 0; const tick = () => { secs++; }; window.setInterval(tick, 1000);\n" +
        "document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });\n" +
        "// setInterval(load, 1000) — commented out\n",
    })).toEqual([]);
  });

  it("still reports the missing-import and shim rules", () => {
    expect(rules({ "a.ts": "declare function subscribeJobEvents(x: unknown): void;\nsubscribeJobEvents({});\n" })).toContain("missing-job-events-import");
    expect(rules({ "job-events.ts": "export {}" })).toContain("no-job-events-shim");
  });
});

describe("miniAppJobEventLint false positives", () => {
  it("ignores re-render after a click, debounced input and save-status helpers", () => {
    expect(rules({
      "a.ts": "async function render(el: HTMLElement) {\n  await fetch('/api/db/query');\n" +
        "  el.querySelector('b')!.addEventListener('click', async () => {\n    try { await fetch('/api/jobs/run'); setTimeout(() => render(el), 15000); }\n    catch { render(el); }\n  });\n" +
        "  let t = 0; el.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => { void render(el); }, 250); });\n}\n" +
        "function status(t: string) { if (t === 'Saved') setTimeout(() => status(''), 1500); }\n" +
        "const save = () => fetch('/api/app/backend/save').catch((e) => { status('Could not save: ' + e.message); });\n",
    })).toEqual([]);
  });
});

describe("publish gate", () => {
  it("lintAppDirForPolling finds polling in an app folder and skips backend/dist", async () => {
    const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lint-"));
    await fs.mkdir(path.join(dir, "backend")); await fs.mkdir(path.join(dir, "views"));
    await fs.writeFile(path.join(dir, "backend", "x.ts"), "setInterval(() => fetch('/api/db/query'), 10);");
    await fs.writeFile(path.join(dir, "views", "a.ts"), "async function u() { await fetch('/api/app/backend/usage'); }\nsetInterval(u, 60000);\n");
    const { lintAppDirForPolling } = await import("./miniAppJobEventLint.js");
    const out = await lintAppDirForPolling(dir);
    expect(out.map((i) => i.file)).toEqual([path.join("views", "a.ts")]);
  });
});
