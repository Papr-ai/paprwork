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


/**
 * Papr design system for gallery posters (Liquid Glass): use these pg-* classes instead of
 * hand-picked colours. They read the app's own tokens (--accent, --font-sans) when present.
 *   .pg-card  one glass card per scene     .pg-kicker  small accent label
 *   .pg-hero  the one big number/status    .pg-title / .pg-text / .pg-muted  type scale
 *   .pg-item  inner row/tile               .pg-row  horizontal group (gap 14px)
 *   .pg-chip (+ .is-ok / .is-accent)       .pg-btn (+ .is-done)   .pg-avatar
 *   .pg-bar > i  progress (set i's width)  .pg-toast  payoff that arrives last
 */
const DESIGN_CSS = `
#papr-film{--pg-accent:var(--accent,#0161E0);--pg-ok:#1a9e63;font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,system-ui,sans-serif);-webkit-font-smoothing:antialiased}
#papr-film{color-scheme:light}
#papr-film.pg-dark{color-scheme:dark}
#papr-film .pg-card :where(p,h1,h2,h3,h4,b,strong,small,span,em,div,article,section,button){color:inherit;margin:0}
#papr-film.pg-light{--pg-fg:#1d1d1f;--pg-fg2:#6e6e73;--pg-glass:rgba(255,255,255,.74);--pg-line:rgba(15,23,42,.08);--pg-sub:rgba(15,23,42,.035);--pg-shadow:0 1px 2px rgba(15,23,42,.06),0 30px 80px rgba(15,23,42,.16)}
#papr-film.pg-dark{--pg-fg:rgba(255,255,255,.94);--pg-fg2:rgba(255,255,255,.6);--pg-glass:rgba(30,32,40,.66);--pg-line:rgba(255,255,255,.12);--pg-sub:rgba(255,255,255,.06);--pg-shadow:0 30px 90px rgba(0,0,0,.45)}
#papr-film.pg-bg.pg-light{background:radial-gradient(70% 60% at 22% 18%,color-mix(in srgb,var(--pg-accent) 22%,transparent),transparent 70%),radial-gradient(60% 60% at 85% 90%,color-mix(in srgb,var(--pg-accent) 14%,transparent),transparent 70%),linear-gradient(160deg,#f6f7fb,#e9edf4)}
#papr-film.pg-bg.pg-dark{background:radial-gradient(70% 60% at 25% 15%,color-mix(in srgb,var(--pg-accent) 34%,transparent),transparent 70%),linear-gradient(160deg,#0d1018,#05070b)}
#papr-film .pg-card{box-sizing:border-box;width:720px;display:flex;flex-direction:column;gap:22px;padding:40px 44px;border-radius:32px;color:var(--pg-fg);background:var(--pg-glass);backdrop-filter:blur(30px) saturate(1.7);box-shadow:var(--pg-shadow),inset 0 0 0 .5px var(--pg-line),inset 0 1px 0 rgba(255,255,255,.35)}
#papr-film .pg-kicker{font-size:17px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--pg-accent)}
#papr-film .pg-hero{font-size:104px;font-weight:700;line-height:.9;letter-spacing:-.05em;font-variant-numeric:tabular-nums}
#papr-film .pg-hero small{font-size:34px;font-weight:600;letter-spacing:-.02em;color:var(--pg-fg2);margin-left:12px}
#papr-film .pg-title{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.15}
#papr-film .pg-text{font-size:22px;line-height:1.45}
#papr-film .pg-muted{font-size:19px;color:var(--pg-fg2)}
#papr-film .pg-row{display:flex;align-items:center;gap:14px}
#papr-film .pg-item{display:flex;align-items:center;gap:16px;padding:18px 20px;border-radius:20px;background:var(--pg-sub);box-shadow:inset 0 0 0 .5px var(--pg-line)}
#papr-film .pg-avatar{flex:none;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;font-size:19px;font-weight:650;color:#fff;background:linear-gradient(160deg,color-mix(in srgb,var(--pg-accent) 70%,#fff),var(--pg-accent))}
#papr-film .pg-chip{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-radius:999px;font-size:18px;font-weight:600;color:var(--pg-fg2);background:var(--pg-sub);box-shadow:inset 0 0 0 .5px var(--pg-line)}
#papr-film .pg-chip.is-ok{color:var(--pg-ok);background:color-mix(in srgb,var(--pg-ok) 12%,transparent)}
#papr-film .pg-chip.is-accent{color:var(--pg-accent);background:color-mix(in srgb,var(--pg-accent) 12%,transparent)}
#papr-film .pg-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:54px;padding:0 28px;border:0;border-radius:16px;font:inherit;font-size:20px;font-weight:650;color:#fff;background:linear-gradient(180deg,color-mix(in srgb,var(--pg-accent) 86%,#fff),var(--pg-accent));box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 8px 22px color-mix(in srgb,var(--pg-accent) 30%,transparent)}
#papr-film .pg-btn.is-done{background:var(--pg-ok);box-shadow:0 8px 22px color-mix(in srgb,var(--pg-ok) 28%,transparent)}
#papr-film .pg-bar{height:14px;border-radius:999px;background:var(--pg-sub);box-shadow:inset 0 0 0 .5px var(--pg-line);overflow:hidden}
#papr-film .pg-bar>i{display:block;height:100%;width:0;border-radius:inherit;background:var(--pg-accent)}
#papr-film .pg-face{display:block;flex:none;width:52px;height:52px;border-radius:50%;object-fit:cover;background:var(--pg-sub)}
#papr-film.pg-dark .pg-kicker,#papr-film.pg-dark .pg-chip.is-accent{color:color-mix(in srgb,var(--pg-accent) 55%,#fff)}
#papr-film .pg-toast{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;color:var(--pg-ok)}
`;

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
  /** Transition length between scenes, seconds (default 0.9). */
  fade?: number;
  /**
   * How one scene hands over to the next (never a plain overlay):
   *  - "lift" (default): the old scene recedes (scales down, softens, fades) while the new one
   *    settles in from slightly larger with a short rise — a clean depth hand-off.
   *  - "push": the old scene slides out left as the new one slides in from the right.
   */
  transition?: "lift" | "push";
  /** Papr design-system look for the pg-* classes and the default background (default "light"). */
  theme?: "light" | "dark";
}

/**
 * Lay out the scenes on the 1280x800 stage and hand Papr's recorder the clock
 * (window.__total / window.__setT). Each scene is its own layer; one is visible at a time.
 */
/** Shortest time a scene stays on screen: long enough to read it before the next one. */
const MIN_SCENE = 2.4;

export function film({ scenes, background, fade = 0.9, transition = "lift", theme = "light" }: FilmOptions): void {
  const w = window as any;
  const durs = scenes.map((s) => Math.max(MIN_SCENE, Number(s.dur) || 0));
  const style = document.createElement("style");
  // Frozen clock: the app's own CSS transitions/animations would smear frames.
  style.textContent = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
  html,body{margin:0;width:1280px;height:800px;overflow:hidden}
  #papr-film{position:fixed;inset:0;${background ? `background:${background};` : ""}}
  .papr-scene{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0}
  .papr-scene{will-change:opacity,transform,filter;transform-origin:50% 55%}
  .papr-fit{flex:none}${DESIGN_CSS}`;
  document.head.appendChild(style);
  const stage = document.createElement("div");
  stage.id = "papr-film";
  stage.className = `pg-${theme}${background ? "" : " pg-bg"}`;
  document.body.appendChild(stage);
  const starts: number[] = [];
  let total = 0;
  const mounts: Promise<void>[] = [];
  // frame() only runs on a scene once its mount() has finished (mounts may be async).
  const mounted = scenes.map(() => false);
  const layers = scenes.map((s, i) => {
    starts.push(total);
    total += durs[i]!;
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
      try { s.frame?.(durs[i]!, el); } catch { /* measured as mounted */ }
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
    t: Math.round((starts[i]! + Math.min(durs[i]! - (i === scenes.length - 1 ? 0.45 : 0.02), Math.max(0, s.screen.at ?? durs[i]!))) * 100) / 100,
    sel: `[data-scene="${i + 1}"] > .papr-fit ${s.screen.shot || "> *"}`,
    caption: s.screen.headline,
    ...(s.screen.key ? { key: s.screen.key } : {}),
    ...(s.screen.sub ? { sub: s.screen.sub } : {}),
  }] : []);
  // A hand-off, not an overlay: the old scene is gone (or nearly) before the new one is fully in.
  const look = (layer: HTMLElement, inP: number, outP: number) => {
    const op = Math.min(inP, 1 - outP);
    let tf = "";
    let blur = 0;
    if (transition === "push") {
      tf = `translateX(${(1 - inP) * 140 - outP * 140}px)`;
    } else {
      const s = 1.05 - 0.05 * inP - 0.07 * outP;
      tf = `translateY(${(1 - inP) * 26 - outP * 14}px) scale(${s})`;
      blur = 10 * Math.max(1 - inP, outP);
    }
    layer.style.opacity = String(op);
    layer.style.transform = tf;
    layer.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
  };
  w.__setT = (t: number) => {
    scenes.forEach((s, i) => {
      const local = t - starts[i]!;
      const d = durs[i]!;
      const last = i === scenes.length - 1;
      // In: the second 70% of the hand-off; out: the first 70% of the next one (they overlap ~40%).
      const inP = i === 0 ? 1 : at(local, fade * 0.3, fade * 0.7, ease.inOut);
      const outP = last ? at(local, d - 0.5, 0.5, ease.inOut) : at(local, d, fade * 0.7, ease.inOut);
      const on = local >= 0 && local < d + (last ? 0.01 : fade);
      const el = layers[i]!;
      const layer = el.parentElement!;
      if (on) look(layer, inP, outP);
      else layer.style.opacity = "0";
      layer.style.visibility = on ? "visible" : "hidden";
      if (on && s.frame && mounted[i]) {
        try {
          // Animations are authored against s.dur; the extra floor time is a hold on the end state.
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
