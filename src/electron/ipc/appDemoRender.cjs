/**
 * App preview video renderer (Electron main).
 *
 * Loads an agent-written demo scene (1920x1080, driven by window.__setT(t)) in a hidden
 * offscreen window, steps a frozen clock frame by frame, captures each frame and encodes
 * an MP4 with WebCodecs in the window's isolated preload (no ffmpeg). Also returns a
 * poster JPEG and a layout check (text too small to read on a card, content off-stage).
 *
 * The scene page is untrusted model output: no node, no network, isolated preload,
 * navigation and window.open blocked.
 */
const fs = require("fs");
const path = require("path");
const { BrowserWindow, ipcMain, session } = require("electron");

/** Scenes are authored on a 1280x720 stage (older drafts may declare window.__stage = [w, h]). */
const OUT_W = 1280;
const OUT_H = 720;
const FPS = 30;
const BITRATE = 1_200_000;
const MAX_SECONDS = 6;
/** Text must be ≥ this many px on the 1280x720 output (≈ 8px on a 460px-wide card). */
const MIN_TEXT_PX = 20;
const PARTITION = "demo-render";

let replyId = 0;
let queue = Promise.resolve();
let sessionReady = false;
const pending = new Map();
let listening = false;

function ensureReplyListener() {
  if (listening) return;
  listening = true;
  ipcMain.on("demo-encode:reply", (event, msg) => {
    const p = msg && pending.get(msg.id);
    if (!p || event.sender !== p.wc) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "encode failed"));
  });
}

function ask(wc, type, payload) {
  const id = ++replyId;
  return new Promise((resolve, reject) => {
    pending.set(id, { wc, resolve, reject });
    wc.send("demo-encode", { id, type, payload });
  });
}

/** Runs in the scene page: text a viewer can't read, and content outside the frame. */
const CHECK_SCRIPT = `(() => {
  const small = new Map(), off = new Set();
  const W = innerWidth, H = innerHeight, MIN = ${MIN_TEXT_PX};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent.trim().replace(/\\s+/g, ' ');
    const el = n.parentElement;
    if (!text || !el || !el.offsetWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    // Effective size = font-size x every ancestor scale x page zoom.
    const px = parseFloat(cs.fontSize) * (box.width / el.offsetWidth);
    if (px < MIN && !small.has(text)) small.set(text.slice(0, 40), Math.round(px));
    if (box.left < -2 || box.top < -2 || box.right > W + 2 || box.bottom > H + 2) off.add(text.slice(0, 40));
  }
  return { small: [...small].slice(0, 20), offStage: [...off].slice(0, 10) };
})()`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ scenePath: string, videoPath: string, posterPath: string }} opts
 * @returns {Promise<{ seconds: number, frames: number, codec: string, bytes: number, check: { small: [string, number][], offStage: string[] } }>}
 */
function renderAppDemoVideo(opts) {
  // One render at a time: each holds an offscreen window and a hardware encoder.
  const run = queue.then(() => renderOnce(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function renderOnce(opts) {
  ensureReplyListener();
  // In-memory session (no "persist:"), shared by renders. Scenes are self-contained:
  // block every request that is not the scene file itself or inline data.
  const ses = session.fromPartition(PARTITION, { cache: false });
  if (!sessionReady) {
    sessionReady = true;
    ses.webRequest.onBeforeRequest((details, cb) => {
      cb({ cancel: !/^(file|data|blob|about|devtools):/.test(details.url) });
    });
  }

  const win = new BrowserWindow({
    show: false,
    width: OUT_W,
    height: OUT_H,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      partition: PARTITION,
      preload: path.join(__dirname, "appDemoRenderPreload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      javascript: true,
      webSecurity: true,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());

  try {
    await win.loadFile(opts.scenePath);
    await wc.executeJavaScript("document.fonts ? document.fonts.ready.then(() => true) : true");
    const info = await wc.executeJavaScript(
      "({ total: Number(window.__total) || 0, ok: typeof window.__setT === 'function', stage: Array.isArray(window.__stage) ? window.__stage : null })",
    );
    if (!info.ok) throw new Error("Scene has no window.__setT");
    // Fit the authored stage to the 1280x720 output.
    const stageW = info.stage && Number(info.stage[0]) > 0 ? Number(info.stage[0]) : OUT_W;
    if (stageW !== OUT_W) wc.setZoomFactor(OUT_W / stageW);
    const seconds = Math.min(MAX_SECONDS, Math.max(2, info.total || 4));
    const frames = Math.round(seconds * FPS);

    const setT = async (t) => {
      await wc.executeJavaScript(
        `try { window.__setT(${t.toFixed(4)}) } catch (e) {}; new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`,
      );
    };
    const grab = async () => {
      wc.invalidate();
      const img = await wc.capturePage({ x: 0, y: 0, width: OUT_W, height: OUT_H });
      const size = img.getSize();
      return size.width === OUT_W && size.height === OUT_H ? img : img.resize({ width: OUT_W, height: OUT_H, quality: "best" });
    };

    // Layout check at the hold point (everything on stage, before the loop fade).
    await setT(seconds * 0.72);
    const check = await wc.executeJavaScript(CHECK_SCRIPT);
    const poster = await grab();
    fs.mkdirSync(path.dirname(opts.posterPath), { recursive: true });
    fs.writeFileSync(opts.posterPath, poster.toJPEG(82));

    const { codec } = await ask(wc, "start", { width: OUT_W, height: OUT_H, fps: FPS, bitrate: BITRATE });
    for (let i = 0; i < frames; i++) {
      await setT(i / FPS);
      const img = await grab();
      const { queued } = await ask(wc, "frame", { index: i, bitmap: img.toBitmap(), width: OUT_W, height: OUT_H });
      if (queued > 8) await wait(10);
    }
    const { mp4 } = await ask(wc, "finish", {});
    const buf = Buffer.from(mp4);
    const tmp = `${opts.videoPath}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, opts.videoPath);
    return { seconds, frames, codec, bytes: buf.length, check };
  } finally {
    // close() (not destroy) lets Chromium tear the frame down; destroy() leaves the
    // next file:// load in this session failing with ERR_FAILED.
    if (!win.isDestroyed()) {
      const closed = new Promise((r) => win.once("closed", r));
      win.close();
      await Promise.race([closed, wait(2000)]);
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

module.exports = { renderAppDemoVideo, MIN_TEXT_PX };
