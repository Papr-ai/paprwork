/**
 * Mini-app preview host for gateways without an Electron parent (cloud agent runs).
 *
 * On desktop, webview_* tools and validate_app's runtime preview go over IPC to
 * Electron, which opens a hidden BrowserWindow. The cloud agent image has no
 * Electron but does ship Playwright Chromium (for browser_*), so this implements
 * the same request/response contract on headless Chromium. Response shapes
 * mirror src/electron/index.cjs handleWebviewTestRequest so callers can't tell
 * the difference.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  WebviewTestRequest,
  WebviewTestResponse,
} from "../../core/types/gateway-ipc.js";

interface ConsoleEntry {
  level: number;
  message: string;
  line?: number;
  sourceId?: string;
  timestamp: string;
}

interface NetworkEntry {
  url: string;
  statusCode: number;
  method: string;
  resourceType: string;
  timestamp: string;
}

interface Session {
  context: BrowserContext;
  page: Page;
  appId: string;
  previewTarget: "local" | "published";
  createdAt: string;
  consoleLogs: ConsoleEntry[];
  networkLogs: NetworkEntry[];
}

const MAX_SESSIONS = 3;
const MAX_LOGS = 500;
const LAUNCH_WAIT_MS = 10_000;
const SCREENSHOT_MAX_WIDTH = 640;

const sessions = new Map<string, Session>();
let defaultId: string | null = null;
let counter = 0;
let browserPromise: Promise<Browser> | null = null;

/** Electron console-message levels: 0 verbose/log, 1 info, 2 warning, 3 error. */
function consoleLevel(type: string): number {
  if (type === "error") return 3;
  if (type === "warning") return 2;
  if (type === "info") return 1;
  return 0;
}

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_LOGS) list.shift();
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
      browser.on("disconnected", () => {
        browserPromise = null;
        sessions.clear();
        defaultId = null;
      });
      return browser;
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function screenshot(page: Page): Promise<string | null> {
  try {
    const width = page.viewportSize()?.width ?? 1280;
    const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
    const png = await page.screenshot({ type: "png", scale: "css", timeout: 8000 });
    if (scale === 1) return `data:image/png;base64,${png.toString("base64")}`;
    // Downscale in the page so we don't pull in an image library.
    const src = `data:image/png;base64,${png.toString("base64")}`;
    const small = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * ${scale});
      c.height = Math.round(img.height * ${scale});
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    })()`);
    return typeof small === "string" ? small : null;
  } catch {
    return null;
  }
}

/** Same guard script as Electron's snapshot visualState. */
const VISUAL_STATE_SCRIPT = `(() => {
  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const brokenHidden = Array.from(document.querySelectorAll('.hidden')).filter(isVisible);
  const overlays = Array.from(document.querySelectorAll('#modal-overlay, .modal-overlay')).filter(isVisible);
  const main = document.getElementById('content') || document.querySelector('main');
  const warnings = [];
  if (brokenHidden.length > 0) warnings.push(brokenHidden.length + ' element(s) have class "hidden" but are still visible — add .hidden { display: none } to CSS');
  if (overlays.length > 0 && main && !main.innerText.trim()) warnings.push('Modal overlay is visible but main content is empty — UI may look blank/blurred to the user');
  const sheets = Array.from(document.styleSheets).filter((s) => s.href || (s.ownerNode && s.ownerNode.textContent));
  if (getComputedStyle(document.body).fontFamily.toLowerCase().includes('times')) warnings.push('Body renders in the browser default serif font — app stylesheets are probably not loading');
  return {
    brokenHiddenCount: brokenHidden.length,
    visibleOverlayCount: overlays.length,
    mainContentEmpty: main ? !main.innerText.trim() : null,
    stylesheetCount: sheets.length,
    warnings,
    boot: null,
    userWouldSeeBlankUi: brokenHidden.length > 0 || (overlays.length > 0 && !!main && !main.innerText.trim()),
  };
})()`;

/** Same wrapper as Electron's wrapWebviewUserScript (script is a function body). */
function wrapUserScript(script: string): string {
  return `(() => {
    try {
      const __paprResult = (function() {
        ${script.trim()}
      })();
      return Promise.resolve(__paprResult).then(
        (value) => ({ __paprExecOk: true, value }),
        (e) => ({ __paprExecOk: false, error: (e && e.message) ? e.message : String(e) }),
      );
    } catch (e) {
      return { __paprExecOk: false, error: (e && e.message) ? e.message : String(e) };
    }
  })()`;
}

async function closeSession(id: string): Promise<void> {
  const s = sessions.get(id);
  sessions.delete(id);
  if (defaultId === id) defaultId = null;
  await s?.context.close().catch(() => undefined);
}

async function launch(payload: Record<string, unknown>): Promise<WebviewTestResponse> {
  const appId = payload.appId;
  if (typeof appId !== "string" || appId.length === 0) {
    return { success: false, error: "appId is required for launch" };
  }
  // Oldest first — each session holds a Chromium context.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))[0];
    await closeSession(oldest[0]);
  }
  const port = process.env.SANDBOX_LOCAL_API_PORT ?? process.env.GATEWAY_PORT ?? "18789";
  const url =
    typeof payload.url === "string" && payload.url.length > 0
      ? payload.url
      : `http://localhost:${port}/apps/${appId}/index.html`;
  const width = Number(payload.width) || 1280;
  const height = Number(payload.height) || 720;

  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const id = `webview-${Date.now()}-${++counter}`;
  const session: Session = {
    context,
    page,
    appId,
    previewTarget: payload.previewTarget === "published" ? "published" : "local",
    createdAt: new Date().toISOString(),
    consoleLogs: [],
    networkLogs: [],
  };
  page.on("console", (msg) => {
    const loc = msg.location();
    push(session.consoleLogs, {
      level: consoleLevel(msg.type()),
      message: msg.text(),
      line: loc.lineNumber,
      sourceId: loc.url || undefined,
      timestamp: new Date().toISOString(),
    });
  });
  page.on("pageerror", (err) => {
    push(session.consoleLogs, {
      level: 3,
      message: `Uncaught ${err.name}: ${err.message}`,
      timestamp: new Date().toISOString(),
    });
  });
  page.on("response", (res) => {
    push(session.networkLogs, {
      url: res.url(),
      statusCode: res.status(),
      method: res.request().method(),
      resourceType: res.request().resourceType(),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (req) => {
    push(session.consoleLogs, {
      level: 3,
      message: `Failed to load ${req.url()}: ${req.failure()?.errorText ?? "request failed"}`,
      timestamp: new Date().toISOString(),
    });
  });
  sessions.set(id, session);
  defaultId = id;

  let status = "loaded";
  let loadError: string | undefined;
  try {
    await page.goto(url, { waitUntil: "load", timeout: LAUNCH_WAIT_MS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(message)) status = "launching";
    else {
      status = "load-error";
      loadError = message;
    }
  }
  const shot = status === "loaded" ? await screenshot(page) : null;
  return {
    success: true,
    data: {
      webviewId: id,
      url,
      previewTarget: session.previewTarget,
      title: await page.title().catch(() => ""),
      status,
      host: "headless-chromium",
      ...(loadError ? { loadError } : {}),
      ...(shot ? { screenshot: shot } : {}),
      ...(status !== "loaded"
        ? {
            hint:
              "Session was created but the page has not finished loading. " +
              "Use page_wait_for({ target: 'mini_app' }) then webview_snapshot.",
          }
        : {}),
    },
  };
}

async function waitFor(id: string, page: Page, payload: Record<string, unknown>): Promise<WebviewTestResponse> {
  const raw = Number(payload.timeout);
  const timeout = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : 30_000;
  if (payload.time !== undefined && payload.time !== null) {
    const seconds = Math.min(Math.max(Number(payload.time) || 1, 0.1), 30);
    await page.waitForTimeout(seconds * 1000);
    return { success: true, data: { webviewId: id, waited: seconds, unit: "seconds" } };
  }
  try {
    if (typeof payload.text === "string" && payload.text) {
      const t = payload.text;
      await page.waitForFunction(`!!document.body && document.body.innerText.includes(${JSON.stringify(t)})`, undefined, { timeout });
      return { success: true, data: { webviewId: id, found: t } };
    }
    if (typeof payload.textGone === "string" && payload.textGone) {
      const t = payload.textGone;
      await page.waitForFunction(`!(document.body && document.body.innerText.includes(${JSON.stringify(t)}))`, undefined, { timeout });
      return { success: true, data: { webviewId: id, gone: t } };
    }
    if (typeof payload.selector === "string" && payload.selector) {
      await page.waitForSelector(payload.selector, { timeout, state: "attached" });
      return { success: true, data: { webviewId: id, found: payload.selector } };
    }
  } catch {
    return {
      success: false,
      error: `Preview wait timed out after ${timeout}ms`,
      data: { webviewId: id, url: page.url() },
    };
  }
  return { success: false, error: "wait_for requires text, textGone, selector, or time" };
}

export async function handleHeadlessWebviewRequest(
  request: WebviewTestRequest,
): Promise<WebviewTestResponse> {
  const payload = request.payload ?? {};
  try {
    if (request.action === "list") {
      return {
        success: true,
        data: {
          sessions: await Promise.all(
            [...sessions.entries()].map(async ([id, s]) => ({
              id,
              url: s.page.url(),
              title: await s.page.title().catch(() => ""),
              createdAt: s.createdAt,
              appId: s.appId,
              previewTarget: s.previewTarget,
            })),
          ),
          defaultWebviewId: defaultId,
        },
      };
    }
    if (request.action === "close") {
      const id = (payload.webviewId as string | undefined) || defaultId;
      if (!id || !sessions.has(id)) return { success: true, data: { closed: false, reason: "not_found" } };
      await closeSession(id);
      return { success: true, data: { closed: true, webviewId: id } };
    }
    if (request.action === "launch") return await launch(payload);

    const id = (payload.webviewId as string | undefined) || defaultId;
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session) return { success: false, error: "No active webview session" };
    const { page } = session;
    if (page.isClosed()) return { success: false, error: "Webview session is no longer available" };

    switch (request.action) {
      case "snapshot": {
        const maxHtml = Number(payload.maxHtmlChars) || 80_000;
        const maxText = Number(payload.maxTextChars) || 12_000;
        const [html, text, visualState] = await Promise.all([
          page.content(),
          page.evaluate<string>("document.body ? document.body.innerText : ''"),
          page.evaluate(VISUAL_STATE_SCRIPT),
        ]);
        const shot = payload.includeScreenshot ? await screenshot(page) : null;
        return {
          success: true,
          data: {
            webviewId: id,
            url: page.url(),
            title: await page.title(),
            html: html.slice(0, maxHtml),
            text: text.slice(0, maxText),
            visualState,
            ...(shot ? { screenshot: shot } : {}),
          },
        };
      }
      case "execute": {
        const script = payload.script;
        if (typeof script !== "string" || !script) return { success: false, error: "script is required for execute" };
        const raw = (await page.evaluate(wrapUserScript(script))) as
          | { __paprExecOk: boolean; value?: unknown; error?: string }
          | undefined;
        if (raw && raw.__paprExecOk === false) {
          return { success: false, error: raw.error || "Script failed in preview session" };
        }
        return { success: true, data: { webviewId: id, url: page.url(), result: raw?.value } };
      }
      case "get_console":
      case "get_network": {
        const list = request.action === "get_console" ? session.consoleLogs : session.networkLogs;
        const logs = list.slice(-(Number(payload.limit) || 100));
        if (payload.clearAfterRead) list.length = 0;
        return { success: true, data: { webviewId: id, logs } };
      }
      case "wait_for":
        return await waitFor(id, page, payload);
      default:
        return { success: false, error: `Unknown webview action: ${request.action}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test helper. */
export async function closeAllHeadlessWebviews(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeSession));
  const b = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  await b?.close().catch(() => undefined);
}
