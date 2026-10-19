/**
 * Papr gallery kit — films an app's REAL components with sample data.
 *
 * An app's gallery lives in its own code at gallery/index.ts. Papr builds it (esbuild,
 * bundled with the app's modules) into one page and records it on a frozen clock:
 * the preview video, then the gallery screens. Import this module FIRST:
 *
 *   import { film, at, ease } from '/__papr__/papr-gallery.ts';   // FIRST: fakes the backend
 *   import './data';                     // calls stub({...}) with sample rows (before components)
 *   import { renderDashboard } from '../dashboard';               // the app's own component
 *   film({ scenes: [{ dur: 1.5, mount, frame, screen: { headline: 'See every reply', key: 'every' } }] });
 *
 * ES modules run in import order, so the kit's fetch patch is in place before any app
 * module loads, and data.ts's stub() runs before any component asks for data.
 *
 * stub() makes components safe to render outside the app (same idea as Launch Video
 * Studio's stage/stub.ts): data calls get sample rows, the desktop bridge is a no-op,
 * nothing reaches the network. Sample data only — never real people or real data.
 */

type Rows = Record<string, unknown>[];
type Json = unknown;

export interface StubOptions {
  /** Rows for /api/db/query and /api/db/batch. Return [] when nothing matches. */
  query?: (sql: string, params: unknown[]) => Rows;
  /** Backend action name -> its JSON result (/api/app/backend/<name>). */
  backend?: Record<string, Json>;
  /** Any other route: URL substring -> JSON body. */
  routes?: Record<string, Json>;
}

const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });

// Anything that would reach the desktop app: a deep no-op that never throws.
const deep = (): any =>
  new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : deep()), apply: () => Promise.resolve(undefined) });

let opts: StubOptions = {};

/** Fake the app's data layer. Call before the app's modules render anything. */
export function stub(o: StubOptions): void {
  opts = o;
}

/** Rows by the first table named after FROM (or JOIN/INTO): byTable({ campaigns: [...] }). */
export function byTable(tables: Record<string, Rows>): (sql: string) => Rows {
  return (sql) => {
    const m = /\b(?:from|join|into|update)\s+["`[]?(\w+)/i.exec(sql);
    return (m && tables[m[1]!]) || [];
  };
}

function rows(sql: unknown, params: unknown): Rows {
  try {
    return opts.query?.(String(sql ?? ""), Array.isArray(params) ? params : []) ?? [];
  } catch {
    return [];
  }
}

async function bodyOf(init?: RequestInit): Promise<any> {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body) : {};
  } catch {
    return {};
  }
}

(() => {
  const w = window as any;
  for (const k of ["papr", "paprAPI", "electron", "electronAPI", "ipcRenderer", "__TAURI__"]) if (!(k in w)) w[k] = deep();
  // Live updates (papr-job-events) never fire in a film.
  w.EventSource = class {
    readyState = 1;
    onmessage = null;
    onerror = null;
    onopen = null;
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = await bodyOf(init);
    if (url.includes("/api/db/batch") || url.includes("/api/db/query-batch")) {
      const st = Array.isArray(body.statements) ? body.statements : [];
      return json({ results: st.map((s: any) => ({ ok: true, rows: rows(s?.sql, s?.params) })) });
    }
    if (url.includes("/api/db/query")) {
      const r = rows(body.sql, body.params);
      return json({ rows: r, data: { rows: r }, columns: Object.keys(r[0] ?? {}), count: r.length });
    }
    if (url.includes("/api/db/write")) return json({ ok: true, changes: 1 });
    const action = /\/api\/app\/backend\/([^/?#]+)/.exec(url)?.[1];
    if (action) {
      const out = opts.backend?.[decodeURIComponent(action)] ?? {};
      return json({ exitCode: 0, stdout: JSON.stringify(out), stderr: "", result: out });
    }
    const hit = Object.keys(opts.routes ?? {}).find((k) => url.includes(k));
    if (hit) return json(opts.routes![hit]);
    // Jobs, files, auth, anything else: a harmless empty success. Never the network.
    return json({ ok: true, runs: [], items: [], files: [], rows: [] });
  };
})();

// ── Time helpers (pure functions of t) ───────────────────────────────────────

/** 0..1 progress of t through [start, start + dur], eased (ease-out cubic). */
export function at(t: number, start: number, dur = 0.5, curve: (x: number) => number = ease.out): number {
  return curve(Math.min(1, Math.max(0, (t - start) / dur)));
}

export const ease = {
  linear: (x: number) => x,
  out: (x: number) => 1 - (1 - x) ** 3,
  inOut: (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  /** Ease-out with a small overshoot (entries that settle). */
  back: (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2,
};

export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** The first n characters of text at progress p (typing). */
export const typed = (text: string, p: number) => text.slice(0, Math.round(text.length * Math.min(1, Math.max(0, p))));

/** An entry: fade + rise (+ slight scale) at progress p, as inline style. */
export function enter(el: HTMLElement | null, p: number, rise = 24): void {
  if (!el) return;
  el.style.opacity = String(p);
  el.style.transform = `translateY(${(1 - p) * rise}px) scale(${0.97 + 0.03 * p})`;
}

// ── The film ─────────────────────────────────────────────────────────────────

export interface GalleryScreen {
  /** 2-5 words, leads with the benefit or a verb. */
  headline: string;
  /** The one headline word shown in the accent colour. */
  key?: string;
  /** One short supporting line (max ~9 words). */
  sub?: string;
  /** CSS selector (inside this scene) of the ONE component to feature. Default: the scene's first child. */
  shot?: string;
  /** Scene-local second to capture (default: the scene's end state). */
  at?: number;
}

export interface Scene {
  /** Seconds this scene is on screen. */
  dur: number;
  /** Build the scene's DOM once (the app's real components, rendered with sample data). May be async. */
  mount: (root: HTMLElement) => void | Promise<void>;
  /** This scene is also a gallery screen: the component under a headline. */
  screen?: GalleryScreen;
  /** Scale the scene so the UI fills the frame (default true). Measured at the scene's end state. */
  fit?: boolean;
  /** Set the scene's look at local time t (0..dur). Pure: no timers, no Date, no random. */
  frame?: (t: number, root: HTMLElement) => void;
}

export interface FilmOptions {
  scenes: Scene[];
  /** Page background behind the app UI (default: the app's own page background). */
  background?: string;
  /** Crossfade between scenes, seconds. */
  fade?: number;
}

/**
 * Lay out the scenes on the 1280x800 stage and hand Papr's recorder the clock
 * (window.__total / window.__setT). Each scene is its own layer; one is visible at a time.
 */
export function film({ scenes, background, fade = 0.35 }: FilmOptions): void {
  const w = window as any;
  const style = document.createElement("style");
  // Frozen clock: the app's own CSS transitions/animations would smear frames.
  style.textContent = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
  html,body{margin:0;width:1280px;height:800px;overflow:hidden}
  #papr-film{position:fixed;inset:0;${background ? `background:${background};` : ""}}
  .papr-scene{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0}
  .papr-fit{flex:none}`;
  document.head.appendChild(style);
  const stage = document.createElement("div");
  stage.id = "papr-film";
  document.body.appendChild(stage);
  const starts: number[] = [];
  let total = 0;
  const mounts: Promise<void>[] = [];
  // frame() only runs on a scene once its mount() has finished (mounts may be async).
  const mounted = scenes.map(() => false);
  const layers = scenes.map((s, i) => {
    starts.push(total);
    total += s.dur;
    const layer = document.createElement("div");
    layer.className = "papr-scene";
    layer.dataset.scene = String(i + 1);
    const el = document.createElement("div");
    el.className = "papr-fit";
    layer.appendChild(el);
    stage.appendChild(layer);
    mounts.push(Promise.resolve().then(() => s.mount(el)).then(() => {
      mounted[i] = true;
      if (s.fit === false) return;
      // Fit the settled UI to ~88% x 85% of the stage, up to 2.2x (small UI must read on a card).
      try { s.frame?.(s.dur, el); } catch { /* measured as mounted */ }
      layer.style.visibility = "visible";
      const w = el.scrollWidth, h = el.scrollHeight;
      if (w > 0 && h > 0) el.style.zoom = String(Math.min(2.2, (1280 * 0.88) / w, (800 * 0.85) / h));
    }).catch((err) => {
      console.error("[gallery] scene failed to mount:", err);
    }));
    return el;
  });
  w.__total = total;
  // The gallery screens, for Papr: when to capture, which element, and the words.
  w.__screens = scenes.flatMap((s, i) => s.screen ? [{
    // Default: the scene's end state (everything typed/counted), before the loop's closing fade.
    t: Math.round((starts[i]! + Math.min(s.dur - (i === scenes.length - 1 ? 0.45 : 0.02), Math.max(0, s.screen.at ?? s.dur))) * 100) / 100,
    sel: `[data-scene="${i + 1}"] > .papr-fit ${s.screen.shot || "> *"}`,
    caption: s.screen.headline,
    ...(s.screen.key ? { key: s.screen.key } : {}),
    ...(s.screen.sub ? { sub: s.screen.sub } : {}),
  }] : []);
  w.__setT = (t: number) => {
    scenes.forEach((s, i) => {
      const local = t - starts[i]!;
      const inP = i === 0 ? 1 : at(local, 0, fade, ease.linear);
      const outP = i === scenes.length - 1 ? 1 - at(local, s.dur - 0.4, 0.4, ease.linear) : 1;
      const on = local >= 0 && local < s.dur + (i === scenes.length - 1 ? 0.01 : fade);
      const el = layers[i]!;
      const layer = el.parentElement!;
      layer.style.opacity = on ? String(Math.min(inP, outP)) : "0";
      layer.style.visibility = on ? "visible" : "hidden";
      if (on && s.frame && mounted[i]) {
        try {
          s.frame(Math.min(s.dur, Math.max(0, local)), el);
        } catch (err) {
          console.error("[gallery] frame failed:", err);
        }
      }
    });
  };
  // Async mounts (components that load their data) finish before the recorder starts.
  w.__ready = Promise.all(mounts).then(() => w.__setT(0));
  w.__setT(0);
}
