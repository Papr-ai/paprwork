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

/** Scenes are authored on a 1280x800 (16:10) stage — the shape of every cover slot.
 *  Older drafts may declare window.__stage = [w, h]. */
const OUT_W = 1280;
const OUT_H = 800;
const FPS = 30;
const BITRATE = 1_200_000;
const MAX_SECONDS = 6;
/** Text must be ≥ this many px on the 1280x800 output (≈ 8px on a 460px-wide card). */
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

/**
 * Runs in the scene page. What a viewer would see as broken:
 *  small    — text too small to read on a card
 *  offStage — content outside the frame
 *  spill    — text wider than the shape holding it (a label leaking out of a ring/pill)
 *  overlap  — two visible pieces of text on top of each other
 */
const CHECK_SCRIPT = `(() => {
  const W = innerWidth, H = innerHeight, MIN = ${MIN_TEXT_PX};
  const small = new Map(), off = new Set(), spill = new Set(), boxes = [];
  const alpha = (el) => {
    let a = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.visibility === 'hidden' || s.display === 'none') return 0;
      a *= Number(s.opacity);
    }
    return a;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent.trim().replace(/\\s+/g, ' ');
    const el = n.parentElement;
    if (!text || !el || !el.offsetWidth || alpha(el) < 0.15) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const box = el.getBoundingClientRect();
    const label = text.slice(0, 40);
    const px = parseFloat(getComputedStyle(el).fontSize) * (box.width / el.offsetWidth);
    if (px < MIN && !small.has(label)) small.set(label, Math.round(px));
    if (r.left < -2 || r.top < -2 || r.right > W + 2 || r.bottom > H + 2) off.add(label);
    const holder = el.parentElement && el.parentElement !== document.body ? el.parentElement.getBoundingClientRect() : null;
    if (r.left < box.left - 3 || r.right > box.right + 3 || (holder && (r.left < holder.left - 3 || r.right > holder.right + 3))) spill.add(label);
    boxes.push({ label, r });
  }
  const overlap = new Set();
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].r, b = boxes[j].r;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 2 && h > 2 && w * h > 0.2 * Math.min(a.width * a.height, b.width * b.height)) {
      overlap.add(boxes[i].label + '" on "' + boxes[j].label);
    }
  }
  return { small: [...small].slice(0, 20), offStage: [...off].slice(0, 10), spill: [...spill].slice(0, 10), overlap: [...overlap].slice(0, 10) };
})()`;

/** Union of two checks (mid-animation + hold), so a clash at either moment counts. */
function mergeChecks(a, b) {
  const uniq = (x, y, key) => {
    const seen = new Set();
    return [...x, ...y].filter((v) => { const k = key(v); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  return {
    small: uniq(a.small, b.small, (v) => v[0]).slice(0, 20),
    offStage: uniq(a.offStage, b.offStage, String).slice(0, 10),
    spill: uniq(a.spill, b.spill, String).slice(0, 10),
    overlap: uniq(a.overlap, b.overlap, String).slice(0, 10),
  };
}

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
    // Fit the authored stage to the 1280x800 output.
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

    // Layout check mid-animation and at the hold point (everything on stage, before the fade).
    await setT(seconds * 0.5);
    const mid = await wc.executeJavaScript(CHECK_SCRIPT);
    await setT(seconds * 0.72);
    const check = mergeChecks(mid, await wc.executeJavaScript(CHECK_SCRIPT));
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
