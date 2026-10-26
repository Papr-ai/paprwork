/**
 * Job SDK papr_files: app id + cloud sandbox resolution.
 *
 * Runs the real Python module against a local HTTP server standing in for
 * either the desktop gateway or the memory server's job-files proxy, so the
 * env contract the job runners set is what is actually exercised.
 */

import { spawnSync } from "child_process";
import http from "http";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SDK = path.resolve(__dirname, "../../src/resources/job-sdk");
const APP = "1b228fc7-af99-4577-85bd-fd1cbb69df51";

let server: http.Server;
let base = "";
const seen: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/cloud/runtime/job-files/url") {
        if (req.headers.authorization !== "Bearer pjdb1.tok") {
          res.statusCode = 401;
          res.end(JSON.stringify({ detail: "Invalid job DB proxy token" }));
          return;
        }
        res.end(JSON.stringify({ url: `https://signed/${body.id}`, location: { kind: "cloud" } }));
        return;
      }
      if (req.url === "/api/files/url") {
        res.end(JSON.stringify({ url: `https://gw/${body.appId}/${body.id}`, location: { kind: "cloud" } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

/** Run python async so the in-process server can answer (spawnSync would block it). */
function py(code: string, env: Record<string, string>): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const { spawn } = require("child_process") as typeof import("child_process");
    const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH, PYTHONPATH: SDK, ...env };
    const p = spawn("python3", ["-c", code], { env: clean });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => resolve({ out: out.trim(), err, code: c ?? 1 }));
  });
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("job SDK papr_files", () => {
  it("reads PAPR_APP_ID (the name both job runners set)", async () => {
    const r = await py("import papr_files; print(papr_files.url('f1'))", {
      PAPR_APP_ID: APP,
      PAPR_GATEWAY_URL: base,
    });
    expect(r.err).toBe("");
    expect(r.out).toBe(`https://gw/${APP}/f1`);
  });

  it("still accepts legacy APP_ID", async () => {
    const r = await py("import papr_files; print(papr_files.url('f2'))", { APP_ID: "legacy", PAPR_GATEWAY_URL: base });
    expect(r.out).toBe("https://gw/legacy/f2");
  });

  it("resolves through the cloud files proxy with the run grant when set", async () => {
    seen.length = 0;
    const r = await py("import papr_files; print(papr_files.url('vid'))", {
      PAPR_APP_ID: APP,
      PAPR_FILES_PROXY_URL: `${base}/v1/cloud/runtime/job-files`,
      PAPR_DB_PROXY_TOKEN: "pjdb1.tok",
      PAPR_GATEWAY_URL: "http://127.0.0.1:1", // must not be used in the pod
    });
    expect(r.err).toBe("");
    expect(r.out).toBe("https://signed/vid");
    expect(seen).toEqual([
      { url: "/v1/cloud/runtime/job-files/url", auth: "Bearer pjdb1.tok", body: { id: "vid" } },
    ]);
  });

  it("surfaces proxy errors as PaprFilesError", async () => {
    const r = await py(
      "import papr_files\ntry:\n  papr_files.url('x')\nexcept papr_files.PaprFilesError as e:\n  print(e)",
      { PAPR_FILES_PROXY_URL: `${base}/v1/cloud/runtime/job-files`, PAPR_DB_PROXY_TOKEN: "wrong" },
    );
    expect(r.out).toBe("file url failed (401): Invalid job DB proxy token");
  });

  it("fails clearly with no app id on the desktop path", async () => {
    const r = await py(
      "import papr_files\ntry:\n  papr_files.url('x')\nexcept papr_files.PaprFilesError as e:\n  print(e)",
      { PAPR_GATEWAY_URL: base },
    );
    expect(r.out).toMatch(/^No app id/);
  });
});
