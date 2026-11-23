/**
 * Cloud agent runs have no Electron parent, so webview_* and validate_app's
 * runtime preview used to fail with "requires Gateway running as Electron child
 * process" and the agent shipped apps it had never seen. They now run on
 * headless Chromium against the sandbox loopback API's /apps/{appId}/ route.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const APP_ID = "081cf3b3-c975-45ec-b433-3a51404bae0d";

import { createRequire } from "module";

function hasChromium(): boolean {
  try {
    const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const chromiumAvailable = hasChromium();

describe.skipIf(!chromiumAvailable)("headless webview host (cloud agent)", () => {
  let tmp: string;
  let server: Server;
  const env = { ...process.env };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-headless-preview-"));
    const dir = path.join(tmp, "apps", APP_ID);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    // Same shape as the broken grocery app: classic <script src="app.js">,
    // only a dist/ bundle on disk, styles in base.css + style.css.
    fs.writeFileSync(
      path.join(dir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="style.css"></head>' +
        '<body><main><h1>Grocery List</h1><ul id="list"></ul></main><script src="app.js"></script></body></html>',
    );
    fs.writeFileSync(path.join(dir, "base.css"), "body{font-family:Helvetica,Arial,sans-serif}");
    fs.writeFileSync(path.join(dir, "style.css"), "h1{color:rgb(1, 97, 224)}");
    fs.writeFileSync(path.join(dir, "app.ts"), "export {};");
    fs.writeFileSync(
      path.join(dir, "dist", "app.js"),
      "document.getElementById('list').innerHTML='<li>Milk</li><li>Eggs</li>';console.error('boom from app');",
    );

    process.env.PAPR_HOME = tmp;
    process.env.PAPR_HEADLESS_WEBVIEW = "1";
    vi.doMock("../../src/core/utils/paprRoot.js", async (orig) => ({
      ...(await orig<object>()),
      getPaprRoot: () => tmp,
    }));
    const { createSandboxLocalApi } = await import(
      "../../src/gateway/services/cloudAgentGateway/sandboxLocalApi.js"
    );
    server = createSandboxLocalApi().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    process.env.SANDBOX_LOCAL_API_PORT = String((server.address() as AddressInfo).port);
  }, 30_000);

  afterAll(async () => {
    const { closeAllHeadlessWebviews } = await import("../../src/gateway/utils/headlessWebviewHost.js");
    await closeAllHeadlessWebviews();
    server?.close();
    vi.doUnmock("../../src/core/utils/paprRoot.js");
    process.env = { ...env };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("launches, renders the bundle, applies styles, captures console + screenshot", async () => {
    const { requestWebviewTest } = await import("../../src/gateway/utils/webviewTestBridge.js");
    const noIpc = { on: () => undefined };

    const launch = await requestWebviewTest({ action: "launch", payload: { appId: APP_ID } }, noIpc);
    expect(launch.success).toBe(true);
    const data = launch.data as { webviewId: string; status: string; screenshot?: string };
    expect(data.status).toBe("loaded");
    expect(data.screenshot).toMatch(/^data:image\/png;base64,/);

    const snap = await requestWebviewTest(
      { action: "snapshot", payload: { webviewId: data.webviewId } },
      noIpc,
    );
    expect((snap.data as { text: string }).text).toContain("Milk");

    const exec = await requestWebviewTest(
      {
        action: "execute",
        payload: {
          script:
            "return { font: getComputedStyle(document.body).fontFamily, h1: getComputedStyle(document.querySelector('h1')).color };",
        },
      },
      noIpc,
    );
    expect(exec.success).toBe(true);
    const styles = (exec.data as { result: { font: string; h1: string } }).result;
    expect(styles.font).toContain("Helvetica");
    expect(styles.h1).toBe("rgb(1, 97, 224)");

    const consoleRes = await requestWebviewTest({ action: "get_console", payload: {} }, noIpc);
    const logs = (consoleRes.data as { logs: Array<{ level: number; message: string }> }).logs;
    expect(logs.some((l) => l.level === 3 && l.message.includes("boom from app"))).toBe(true);

    const close = await requestWebviewTest({ action: "close", payload: {} }, noIpc);
    expect((close.data as { closed: boolean }).closed).toBe(true);
  }, 60_000);

  it("still refuses outside cloud mode when not opted in", async () => {
    delete process.env.PAPR_HEADLESS_WEBVIEW;
    const prevMode = process.env.GATEWAY_MODE;
    delete process.env.GATEWAY_MODE;
    const { requestWebviewTest } = await import("../../src/gateway/utils/webviewTestBridge.js");
    await expect(
      requestWebviewTest({ action: "list" }, { on: () => undefined }),
    ).rejects.toThrow(/Electron child process/);
    process.env.PAPR_HEADLESS_WEBVIEW = "1";
    if (prevMode !== undefined) process.env.GATEWAY_MODE = prevMode;
  });
});
