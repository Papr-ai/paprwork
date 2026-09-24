/**
 * Vitest globalSetup: bundle the DB query worker once per run.
 *
 * Production resolves `workers/db-query-worker.js` next to the compiled
 * gateway. Under vitest only the `.ts` source exists, so any
 * LocalStorageProvider built with the default URL spawned a worker that died
 * with "Cannot find module …/db-query-worker.js" → "DB worker exited
 * unexpectedly (code 1)" → "DB worker is not running".
 *
 * We bundle the worker to a temp `.mjs` (externals resolve through a
 * node_modules symlink) and publish its URL via PAPR_DB_QUERY_WORKER_URL,
 * which LocalStorageProvider honors for its default read-worker URL.
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function setup(): Promise<() => void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "papr-db-query-worker-"));
  symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "dir");
  const outfile = path.join(dir, "db-query-worker.mjs");
  await build({
    entryPoints: [path.resolve("src/gateway/workers/db-query-worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  process.env.PAPR_DB_QUERY_WORKER_URL = pathToFileURL(outfile).href;
  return () => rmSync(dir, { recursive: true, force: true });
}
