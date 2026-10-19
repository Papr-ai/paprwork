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
const MAX_SECONDS = 16;
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

const MAX_STILLS = 8;

/** What the viewer sees at (x, y) in 0..1: the element, its text and its nearest labelled parents. */
const PROBE_SCRIPT = `(x, y) => {
  const el = document.elementFromPoint(x * innerWidth, y * innerHeight);
  if (!el) return null;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
    (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  const text = (e) => (e.innerText || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const path = [];
  for (let e = el; e && e !== document.body && path.length < 4; e = e.parentElement) path.push(name(e));
  const r = el.getBoundingClientRect();
  return { element: name(el), text: text(el), path: path.join(' < '),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
}`;

/** Gallery screen (older style): cut one region (fractions 0..1) and scale it to the card's 2x width. */
const SCREEN_W = 1120;
function cropStill(img, c) {
  const f = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  const w = Math.max(64, Math.round(f(c.w) * OUT_W));
  const h = Math.max(40, Math.round(f(c.h) * OUT_H));
  const x = Math.min(OUT_W - w, Math.round(f(c.x) * OUT_W));
  const y = Math.min(OUT_H - h, Math.round(f(c.y) * OUT_H));
  const cut = img.crop({ x, y, width: w, height: h });
  return w === SCREEN_W ? cut : cut.resize({ width: SCREEN_W, quality: "best" });
}

/**
 * Runs in the scene page. Snap a picked region (fractions) to the one component it frames:
 * the visible element whose box best overlaps it. Falls back to the region itself.
 */
const SNAP_SCRIPT = `(c) => {
  const W = innerWidth, H = innerHeight;
  const R = { l: c.x * W, t: c.y * H, r: (c.x + c.w) * W, b: (c.y + c.h) * H };
  const area = (a) => Math.max(0, a.r - a.l) * Math.max(0, a.b - a.t);
  const ra = area(R);
  // A "card": something with its own surface (background, border or shadow).
  const surface = (st) => (st.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(st.backgroundColor))
    || parseFloat(st.borderTopWidth) > 0 || (st.boxShadow && st.boxShadow !== 'none');
  let best = null, score = 0, hold = null, holdArea = Infinity;
  for (const el of document.body.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width < W * 0.16 || b.height < H * 0.1 || b.width * b.height > W * H * 0.8) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.5) continue;
    const e = { l: b.left, t: b.top, r: b.right, b: b.bottom };
    const ea = area(e);
    const i = area({ l: Math.max(e.l, R.l), t: Math.max(e.t, R.t), r: Math.min(e.r, R.r), b: Math.min(e.b, R.b) });
    const iou = i / (ea + ra - i);
    if (iou > score) { score = iou; best = e; }
    // Fallback: the smallest card that holds most of the picked region.
    if (surface(st) && i >= 0.8 * ra && ea <= 4 * ra && ea < holdArea) { hold = e; holdArea = ea; }
  }
  const box = score >= 0.6 ? best : hold || (score >= 0.4 ? best : R);
  const pad = 2;
  const l = Math.max(0, box.l - pad), t = Math.max(0, box.t - pad);
  return { x: l, y: t, width: Math.min(W, box.r + pad) - l, height: Math.min(H, box.b + pad) - t, snapped: box !== R };
}`;

/** Average colour of a frame and its most saturated colour (the accent), as [r, g, b]. */
function frameTones(img) {
  const small = img.resize({ width: 32, height: 20 });
  const px = small.toBitmap(); // BGRA
  let r = 0, g = 0, b = 0, n = 0, accent = null, best = 0.28;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const B = px[i], G = px[i + 1], R = px[i + 2];
    r += R; g += G; b += B; n++;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const sat = max ? (max - min) / max : 0;
    if (sat * (max / 255) > best) { best = sat * (max / 255); accent = [R, G, B]; }
  }
  return { tone: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], accent };
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * One gallery screen laid out like a Launch Video Studio scene: headline centered on top
 * (key word in the accent), one supporting line, the real component floating large on a
 * calm background in the app's own colours.
 */
function composeHtml(c) {
  const [r, g, b] = Array.isArray(c.tone) ? c.tone : [238, 244, 255];
  const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
  const mix = (t, to) => `rgb(${[r, g, b].map((v) => Math.round(v + (to - v) * t)).join(",")})`;
  const bg1 = dark ? mix(0.45, 0) : mix(0.86, 255);
  const bg2 = dark ? mix(0.15, 0) : mix(0.7, 255);
  const a = Array.isArray(c.accent) ? c.accent : null;
  const lumA = a ? (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) / 255 : 0;
  // Neon accents (cyan, lime) vanish on light backgrounds; dark ones on dark. Pull toward readable first.
  const fixT = a ? (dark ? Math.max(0, (0.55 - lumA) / (1 - lumA)) : Math.max(0, (lumA - 0.38) / lumA)) : 0;
  const base = a ? a.map((v) => Math.round(v + ((dark ? 255 : 0) - v) * fixT)) : null;
  const shade = (t, to) => (base ? `rgb(${base.map((v) => Math.round(v + (to - v) * t)).join(",")})` : null);
  const gFrom = a ? shade(dark ? 0 : 0.15, 0) : "#0060E0";
  const gTo = a ? shade(dark ? 0.35 : 0.25, 255) : "#00ACFA";
  const glow = a ? `rgba(${a.join(",")},${dark ? 0.24 : 0.1})` : "rgba(0,120,255,0.14)";
  const ink = dark ? "#fff" : "#0f172a";
  const muted = dark ? "rgba(255,255,255,0.68)" : "#5b6474";
  const words = String(c.caption || "").split(/\s+/).filter(Boolean);
  const key = String(c.key || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const head = words.map((w) => {
    const hit = key && w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === key;
    return hit ? `<span class="g">${esc(w)}</span>` : esc(w);
  }).join(" ");
  const sub = String(c.sub || "").trim();
  const card = dark
    ? "0 34px 90px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08)"
    : "0 30px 80px rgba(10,26,58,.16), 0 0 0 1px rgba(10,26,58,.06)";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${OUT_W}px;height:${OUT_H}px;overflow:hidden}
body{position:relative;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;
  background:radial-gradient(60% 55% at 50% 68%,${glow},transparent 70%),linear-gradient(160deg,${bg1},${bg2});-webkit-font-smoothing:antialiased}
h1{position:absolute;left:72px;right:72px;top:60px;margin:0;text-align:center;font-size:${words.join(" ").length > 26 ? 46 : 54}px;font-weight:750;letter-spacing:-0.025em;line-height:1.1;color:${ink}}
.g{background:linear-gradient(90deg,${gFrom},${gTo});-webkit-background-clip:text;background-clip:text;color:transparent}
p{position:absolute;left:72px;right:72px;top:${words.join(" ").length > 26 ? 128 : 136}px;margin:0;text-align:center;font-size:24px;font-weight:500;color:${muted}}
img{position:absolute;display:block;border-radius:${c.radius != null ? 0 : 18}px;box-shadow:${card}}
</style></head><body><h1>${head}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}<img src="${esc(path.basename(c.raw))}">
<script>
window.__layout = () => {
  const img = document.querySelector('img');
  const top = ${sub ? 206 : 166}, bottom = 56, side = 72;
  const w = img.naturalWidth / devicePixelRatio, h = img.naturalHeight / devicePixelRatio;
  const s = Math.min(2.6, (${OUT_W} - side * 2) / w, (${OUT_H} - top - bottom) / h);
  img.style.width = (w * s) + 'px'; img.style.height = (h * s) + 'px';
  ${c.radius != null ? `img.style.borderRadius = (${Number(c.radius) || 0} * w * s) + 'px';` : ""}
  img.style.left = ((${OUT_W} - w * s) / 2) + 'px';
  img.style.top = (top + (${OUT_H} - top - bottom - h * s) / 2) + 'px';
  return true;
};
</script></body></html>`;
}

/** Lay out each screen (compose mode) and save it as a JPEG at the display's full resolution. */
async function composeScreens(win, items) {
  const wc = win.webContents;
  for (const c of items.slice(0, MAX_STILLS)) {
    if (!fs.existsSync(c.raw)) continue;
    const html = `${c.path}.html`;
    fs.writeFileSync(html, composeHtml(c));
    try {
      await win.loadFile(html);
      wc.setZoomFactor(1);
      await wc.executeJavaScript("document.querySelector('img').decode().then(() => window.__layout()).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))");
      wc.invalidate();
      await wait(60);
      const img = await wc.capturePage({ x: 0, y: 0, width: OUT_W, height: OUT_H });
      fs.writeFileSync(c.path, img.toJPEG(90));
    } finally {
      fs.rmSync(html, { force: true });
    }
  }
  return { seconds: 0, frames: 0, codec: "", bytes: 0, check: { small: [], offStage: [] }, stills: [] };
}

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

  // Page errors (a gallery component that throws) go back to the agent as feedback.
  const errors = [];
  wc.on("console-message", (e, level, message) => {
    const lvl = e && e.level !== undefined ? e.level : level;
    const msg = e && e.message !== undefined ? e.message : message;
    if ((lvl === "error" || lvl === 3) && errors.length < 10) errors.push(String(msg).slice(0, 300));
  });
  try {
    if (Array.isArray(opts.compose)) return await composeScreens(win, opts.compose);
    await win.loadFile(opts.scenePath);
    // Gallery films mount the app's real components, possibly async (they load sample data).
    await wc.executeJavaScript("Promise.race([Promise.resolve(window.__ready).then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))])");
    await wc.executeJavaScript("document.fonts ? document.fonts.ready.then(() => true) : true");
    const info = await wc.executeJavaScript(
      "({ total: Number(window.__total) || 0, ok: typeof window.__setT === 'function', stage: Array.isArray(window.__stage) ? window.__stage : null, screens: Array.isArray(window.__screens) ? JSON.parse(JSON.stringify(window.__screens)) : null })",
    );
    if (!info.ok) throw new Error("Scene has no window.__setT");
    // Fit the authored stage to the 1280x800 output.
    const stageW = info.stage && Number(info.stage[0]) > 0 ? Number(info.stage[0]) : OUT_W;
    // Zoom sticks per origin in the shared session: always set it.
    wc.setZoomFactor(stageW !== OUT_W ? OUT_W / stageW : 1);
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

    // Stills mode: frames at chosen moments (for review / notes), plus what sits under a pin.
    if (Array.isArray(opts.stills)) {
      const stills = [];
      for (const s of opts.stills.slice(0, MAX_STILLS)) {
        const t = Math.min(seconds, Math.max(0, Number(s.t) || 0));
        await setT(t);
        const frame = await grab();
        if (s.snap && s.sel) {
          // Gallery film screen: the element the gallery code names, captured sharp.
          const z = wc.getZoomFactor();
          const box = await wc.executeJavaScript(`(() => {
            let el = document.querySelector(${JSON.stringify(String(s.sel))});
            if (!el) return null;
            const surf = (st) => (st.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(st.backgroundColor)) || (st.boxShadow && st.boxShadow !== 'none') || parseFloat(st.borderTopWidth) > 0;
            // A wrapper around one card (card behind card): use the inner card, so the corners and edges are the card's own.
            for (let i = 0; i < 4; i++) {
              const kids = [...el.children].filter((k) => { const r = k.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(k).visibility !== 'hidden'; });
              if (kids.length !== 1) break;
              const ob = el.getBoundingClientRect(), kb = kids[0].getBoundingClientRect();
              if (kb.width * kb.height < 0.6 * ob.width * ob.height) break;
              el = kids[0];
            }
            const b = el.getBoundingClientRect(), st = getComputedStyle(el);
            // A card (own surface): cut on its edge and keep its corner radius. A bare wrapper: frame it with real margin.
            const card = surf(st);
            const fit = el.closest('.papr-fit'), zf = (fit && Number(fit.style.zoom)) || 1;
            const own = Math.min(parseFloat(st.borderTopLeftRadius) || 0, b.width / 2, b.height / 2) * zf;
            const p = card ? 0 : 36;
            const l = Math.max(0, b.left - p), t = Math.max(0, b.top - p);
            const width = Math.min(innerWidth, b.right + p) - l;
            return { x: l, y: t, width, height: Math.min(innerHeight, b.bottom + p) - t, radius: (card ? own : 28) / width };
          })()`);
          if (!box || box.width < 24 || box.height < 16) { stills.push({ t, path: s.path, missing: true }); continue; }
          const rect = { x: Math.round(box.x * z), y: Math.round(box.y * z), width: Math.round(box.width * z), height: Math.round(box.height * z) };
          fs.writeFileSync(s.path, (await wc.capturePage(rect)).toPNG());
          const W = OUT_W / z, H = OUT_H / z;
          const crop = { x: box.x / W, y: box.y / H, w: box.width / W, h: box.height / H };
          stills.push({ t, path: s.path, snapped: true, crop, radius: box.radius || 0, ...frameTones(frame) });
          continue;
        }
        if (s.snap && s.crop) {
          // Gallery screen: the one component, captured at the display's full resolution (sharp).
          const z = wc.getZoomFactor();
          const box = await wc.executeJavaScript(`(${SNAP_SCRIPT})(${JSON.stringify({ x: +s.crop.x || 0, y: +s.crop.y || 0, w: +s.crop.w || 0, h: +s.crop.h || 0 })})`);
          const rect = { x: Math.round(box.x * z), y: Math.round(box.y * z), width: Math.max(32, Math.round(box.width * z)), height: Math.max(24, Math.round(box.height * z)) };
          fs.writeFileSync(s.path, (await wc.capturePage(rect)).toPNG());
          stills.push({ t, path: s.path, snapped: !!box.snapped, ...frameTones(frame) });
          continue;
        }
        fs.writeFileSync(s.path, (s.crop ? cropStill(frame, s.crop) : frame).toJPEG(s.crop ? 88 : 80));
        const probe = s.probe
          ? await wc.executeJavaScript(`(${PROBE_SCRIPT})(${Number(s.probe.x) || 0}, ${Number(s.probe.y) || 0})`)
          : undefined;
        stills.push({ t, path: s.path, probe });
      }
      return { seconds, frames: 0, codec: "", bytes: 0, check: { small: [], offStage: [] }, stills };
    }

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
    return { seconds, frames, codec, bytes: buf.length, check, ...(info.screens ? { screens: info.screens } : {}), ...(errors.length ? { errors } : {}) };
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
