#!/usr/bin/env node
/**
 * Phase C/D smoke test — background worker child + concurrency helpers.
 *
 * Usage:
 *   npm run build:gateway
 *   npm run test:gateway-background-phases
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(
  root,
  "dist/gateway/services/gatewayBackgroundWorkerEntry.js",
);

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      env: { ...process.env, GATEWAY_BACKGROUND_PROCESS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ out, err });
      } else {
        reject(new Error(err || out || `exit ${code}`));
      }
    });
  });
}

async function testConcurrencyModule() {
  const snippet = `
    import {
      resolveGatewayBackgroundMaxConcurrency,
      resolveDbQueryPoolSize,
    } from "./src/gateway/services/gatewayBackgroundConcurrency.ts";
    const n = resolveGatewayBackgroundMaxConcurrency();
    if (n < 1 || n > 4) throw new Error("bad concurrency " + n);
    const pool = resolveDbQueryPoolSize();
    if (pool < 1) throw new Error("bad pool");
    console.log("concurrency_ok", n, pool);
  `;
  const tmp = path.join(root, ".tmp-bg-concurrency-test.mjs");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(tmp, snippet, "utf8"),
  );
  const { out } = await runNode(tmp);
  if (!out.includes("concurrency_ok")) {
    throw new Error(`unexpected output: ${out}`);
  }
}

async function testBackgroundChildPing() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GATEWAY_PORT: "18789",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("background child boot timeout"));
    }, 15_000);

    child.on("message", (msg) => {
      if (msg?.type === "ready") {
        clearTimeout(timer);
        child.send({ type: "shutdown" });
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`background child exit ${code}`));
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("Cannot find module")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(text));
      }
    });
  });
}

async function main() {
  console.log("[test-gateway-background-phases] concurrency module…");
  await testConcurrencyModule();
  console.log("[test-gateway-background-phases] background child ready…");
  await testBackgroundChildPing();
  console.log("[test-gateway-background-phases] OK");
}

main().catch((err) => {
  console.error("[test-gateway-background-phases] FAILED:", err.message);
  process.exit(1);
});
