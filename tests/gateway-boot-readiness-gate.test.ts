/**
 * The gateway must not answer "this does not exist" for a route it has not
 * registered yet.
 *
 * These run against a real Express app on a real socket rather than fake
 * `req`/`res` objects, because two of the things under test are Express's own:
 * content negotiation via `req.accepts`, and the fact that middleware order
 * decides who answers. A hand-rolled `accepts` stub could agree with my reading
 * of the header and disagree with the library, which is the shape of test that
 * passes while production breaks.
 */

import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOOT_GATE_MAX_WAIT_MS,
  createGatewayBootGate,
  isBootGateExemptPath,
  renderBootGatePage,
} from "../src/gateway/services/gatewayBootGate.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY_INDEX = "src/gateway/index.ts";

/**
 * Read source with comments stripped.
 *
 * An anchor search that sees comments passes against code that has been
 * commented out — verified the hard way on a previous static test, which stayed
 * green while the line it guarded did nothing.
 *
 * Line comments go first, and the order is load-bearing: this file has several
 * line comments that mention a route glob (`// Unknown /api/* must not ...`).
 * Stripping block comments first reads that `/*` as an opening delimiter and
 * deletes everything up to the next `*\/` — about 340 lines here, including the
 * anchors below. The `requireIndex` throw is what caught it.
 */
function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf-8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function requireIndex(content: string, anchor: string, label: string): number {
  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `${label} not found in ${GATEWAY_INDEX}: ${JSON.stringify(anchor)} — the ` +
        `code was renamed or rewrapped. Update the anchor, never delete the ` +
        `invariant.`,
    );
  }
  return index;
}

/**
 * A gateway shaped like the real one: something registered before the gate (the
 * production UI static handler), the gate, then the routes that in production
 * only arrive after `initializeServices()`.
 */
async function startHarness(): Promise<{
  url: string;
  setReady: (ready: boolean) => void;
  close: () => Promise<void>;
}> {
  let ready = false;
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: ready ? "ok" : "starting" });
  });
  app.get("/early-asset.js", (_req, res) => {
    res.type("js").send("// served during boot");
  });

  app.use(createGatewayBootGate(() => ready));

  // Registered after the gate, exactly as every real route is.
  app.get("/apps/:appId/index.html", (_req, res) => {
    res.type("html").send("<!DOCTYPE html><title>real app</title>");
  });
  app.post("/api/db/query", (_req, res) => {
    res.json({ rows: [] });
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    setReady: (next) => {
      ready = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

let harness: Awaited<ReturnType<typeof startHarness>> | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("the boot window answers 503, not 404", () => {
  it("hands a document request a page that waits, naming the path it was asked for", async () => {
    harness = await startHarness();

    const res = await fetch(`${harness.url}/apps/abc-123/index.html`, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });

    // 503 rather than 404 is the whole point: 503 means "ask again", 404 means
    // "stop asking". The wrong one sends the user looking for a file that was
    // never missing.
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    // A cached retry page would sit in front of the real app all session.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(body).toContain("Starting the local gateway");
    expect(body).toContain("/apps/abc-123/index.html");
    // The iframe repairs itself; nothing in the renderer has to notice.
    expect(body).toContain('fetch("/health"');
    expect(body).toContain("location.reload()");
  });

  it("hands a fetch caller JSON, because an app parsing HTML as JSON looks like its own bug", async () => {
    harness = await startHarness();

    const res = await fetch(`${harness.url}/api/db/query`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      error: string;
      phase: string;
      retryAfterMs: number;
    };
    expect(body.phase).toBe("starting");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.error).toMatch(/starting/i);
  });

  it("treats a request with no Accept header as programmatic", async () => {
    harness = await startHarness();

    // `fetch` sends no Accept by default; browsers always send one for a
    // navigation. So absence means code, and code wants JSON.
    const res = await fetch(`${harness.url}/api/db/query`, { method: "POST" });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("cannot be made to inject through the URL it echoes", async () => {
    harness = await startHarness();

    const res = await fetch(
      `${harness.url}/apps/x/index.html?q=%3Cscript%3Ealert(1)%3C/script%3E`,
      { headers: { accept: "text/html" } },
    );
    const body = await res.text();

    // Two defences, and the test found that the first one alone is doing the
    // work here: Express leaves `originalUrl` percent-encoded, so no raw `<`
    // ever reaches the template. The escaper is still asserted directly below,
    // since that is the layer that would matter if a caller ever passed a
    // decoded path.
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("%3Cscript%3E");
  });

  it("escapes a decoded path, which is the case the encoding above does not cover", () => {
    const page = renderBootGatePage('/apps/<script>alert("x")</script>/index.html');

    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&quot;");
  });
});

describe("what must keep working while the gate is closed", () => {
  it("still answers /health, which is what the retry page waits on", async () => {
    harness = await startHarness();

    const res = await fetch(`${harness.url}/health`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("starting");
  });

  it("still serves anything registered ahead of the gate, so the app shell loads", async () => {
    harness = await startHarness();

    // The production UI static handler sits in front of the gate for exactly
    // this reason: gating it would replace one broken screen with a blank one.
    const res = await fetch(`${harness.url}/early-asset.js`);

    expect(res.status).toBe(200);
  });

  it("names /health in the exempt list even though ordering already spares it", async () => {
    // Belt and braces: the retry page polls /health, so a future reorder that
    // put the gate in front of it would deadlock the page against itself.
    expect(isBootGateExemptPath("/health")).toBe(true);
    expect(isBootGateExemptPath("/apps/abc/index.html")).toBe(false);
  });
});

describe("the gate opens", () => {
  it("reads readiness per request rather than capturing it", async () => {
    harness = await startHarness();

    const before = await fetch(`${harness.url}/apps/abc-123/index.html`, {
      headers: { accept: "text/html" },
    });
    expect(before.status).toBe(503);

    harness.setReady(true);

    const after = await fetch(`${harness.url}/apps/abc-123/index.html`, {
      headers: { accept: "text/html" },
    });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("real app");
  });

  it("falls through to Express's own 404 for a route that truly does not exist", async () => {
    harness = await startHarness();
    harness.setReady(true);

    // Once ready, "not found" means not found — the gate must not turn every
    // genuine 404 into a permanent "still starting".
    const res = await fetch(`${harness.url}/apps/abc/nope.html`, {
      headers: { accept: "text/html" },
    });

    expect(res.status).toBe(404);
  });
});

describe("the retry page is bounded", () => {
  it("stops reloading and says so, rather than spinning silently forever", () => {
    const page = renderBootGatePage("/apps/abc/index.html");

    expect(page).toContain("deadline");
    expect(page).toContain("giveUp");
    expect(page).toContain("Try again");
    // Longer than the 60s main waits before loading the UI anyway — this page
    // exists because that budget was blown.
    expect(BOOT_GATE_MAX_WAIT_MS).toBeGreaterThan(60_000);
  });

  it("carries no external references, since asset routes may not exist yet", () => {
    const page = renderBootGatePage("/apps/abc/index.html");

    expect(page).not.toMatch(/<link[^>]+href=/i);
    expect(page).not.toMatch(/<script[^>]+src=/i);
  });
});

describe("registration order in the real gateway", () => {
  const source = readCode(GATEWAY_INDEX);

  it("registers the gate after the early UI handler and before listen", () => {
    const earlyUi = requireIndex(
      source,
      "registerEarlyProductionUi(app);",
      "early production UI registration",
    );
    const gate = requireIndex(
      source,
      "app.use(createGatewayBootGate(",
      "boot gate registration",
    );
    const listen = requireIndex(
      source,
      '"pre-http", "listenGatewayServer"',
      "listenGatewayServer startup step",
    );

    // After the static handler: the app shell must still load during boot.
    expect(gate).toBeGreaterThan(earlyUi);
    // Before listen: otherwise the first requests of the window slip past it.
    expect(gate).toBeLessThan(listen);
  });

  it("flips gatewayReady only after the routes the gate stands in for", () => {
    // The gate's promise is "if this is closed, the route may not exist". That
    // holds only while readiness is the *last* thing set. Flipping it earlier
    // would open the gate over routes that are still missing.
    const appsRoute = requireIndex(
      source,
      "app.get(/^\\/apps\\/([^/]+)\\/?(.*)$/",
      "mini-app file route",
    );
    const ready = requireIndex(source, "gatewayReady = true;", "gatewayReady assignment");

    expect(ready).toBeGreaterThan(appsRoute);
  });
});
