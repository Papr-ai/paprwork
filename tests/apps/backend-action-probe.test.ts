import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = { dir: "" };
vi.mock("../../src/core/utils/paprRoot.js", () => ({ getPaprRoot: () => root.dir }));

const { probeBackendActions } = await import("../../src/gateway/utils/backendActionProbe.js");

const APP = "probe-app";

async function app(actions: Record<string, { handler: string; code: string; keys?: string[]; required?: boolean }>) {
  const dir = join(root.dir, "apps", APP, "backend");
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = {};
  for (const [name, a] of Object.entries(actions)) {
    manifest[name] = {
      handler: a.handler,
      runtime: "python",
      ...(a.keys ? { keys: a.keys } : {}),
      ...(a.required ? { input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } : {}),
    };
    await writeFile(join(dir, a.handler), a.code);
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, actions: manifest }));
}

describe("probeBackendActions (validate_app)", () => {
  beforeEach(async () => {
    root.dir = await mkdtemp(join(tmpdir(), "papr-probe-"));
  });
  afterEach(async () => {
    await rm(root.dir, { recursive: true, force: true });
  });

  it("fails a crashing action and a column-name-echo action; passes a good one", async () => {
    await app({
      good: { handler: "good.py", code: "import json\nprint(json.dumps({'items':[{'id':1,'name':'Milk'}]}))\n" },
      crash: { handler: "crash.py", code: "raise AttributeError(\"'list' object has no attribute 'fetchall'\")\n" },
      echo: { handler: "echo.py", code: "import json\nprint(json.dumps({'items':[{'id':'id','name':'name'},{'id':'id','name':'name'}]}))\n" },
    });
    const r = await probeBackendActions(APP, new Set());
    expect(r.probed.sort()).toEqual(["crash", "echo", "good"]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.find((e) => e.includes('"crash"'))).toContain("fetchall");
    expect(r.errors.find((e) => e.includes('"echo"'))).toContain("column names");
  });

  it("treats a blocked write as reaching the write path, not a failure", async () => {
    await app({
      add: {
        handler: "add.py",
        code: "import sys\nsys.stderr.write('RuntimeError: Backend DB proxy HTTP 409: validate_app probe: writes are blocked during the check')\nsys.exit(1)\n",
      },
    });
    expect((await probeBackendActions(APP, new Set())).errors).toEqual([]);
  });

  it("skips actions with vault keys, required input, ping, and ones the preview already called", async () => {
    await app({
      ping: { handler: "ping.py", code: "raise SystemExit(1)\n" },
      send: { handler: "send.py", code: "raise SystemExit(1)\n", keys: ["TWILIO_KEY"] },
      search: { handler: "search.py", code: "raise SystemExit(1)\n", required: true },
      items: { handler: "items.py", code: "raise SystemExit(1)\n" },
    });
    const r = await probeBackendActions(APP, new Set(["items"]));
    expect(r.errors).toEqual([]);
    expect(r.probed).toEqual([]);
    expect(r.skipped.map((s) => s.action).sort()).toEqual(["search", "send"]);
  });

  it("no backend → nothing to do", async () => {
    expect(await probeBackendActions(APP, new Set())).toEqual({ errors: [], probed: [], skipped: [] });
  });
});
