/**
 * App demo scenes — a 3–5s animated preview loop that explains what an app does.
 *
 * The Papr agent (AgentService.runStructuredJobSession) reads the app's code and writes a
 * self-contained HTML scene that reuses the app's own components + CSS with invented sample
 * data, so model choice, auth (OAuth / API key / Papr proxy) and fallbacks match Paprwork.
 *
 * Stored privately at <papr>/data/demos/{appId}.html (gitignored with data/), never synced.
 * The scene exposes window.__total + window.__setT(t); the player drives it by time.
 */
import * as fs from "fs";
import * as path from "path";
import { getPaprAppsRoot, getPaprDataDir } from "../../core/utils/paprRoot.js";

const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_BUDGET = 90_000;
const SKIP = /node_modules|(^|\/)dist\/|__papr__|\.d\.ts$|(^|\/)assets\/|(^|\/)content\//;

export const DEMO_SCENE_SYSTEM = `You design App Store-style animated preview loops for small web apps ("mini-apps").
You get the app's source. Produce ONE self-contained HTML file: a 1920x1080 scene that explains what the app does in 3-5 seconds, like an iOS App Store preview card.

How it should look:
- NOT a screen recording or a full screenshot of the app. Compose 1-4 floating pieces of the app's real UI (cards, scores, table rows, charts, chips, inputs) on a soft gradient background that fits the app's palette. Generous whitespace, large type (min 28px; key numbers 72-140px), soft big shadows, rounded corners.
- Reuse the app's own components: copy its markup structure and class names from the view code and its CSS (the app's CSS is injected for you as <style id="app-css">). Then scale them up: wrap each piece in a container with transform: scale(1.6-2.2) or set large font sizes, so every label is at least 28px on the 1920x1080 canvas. Never copy its full page layout or nav bar.
- Show the app's core job as a tiny story: input -> the app working -> the payoff (score, insight, list, chart, draft...). The payoff must be the hero.
- Invent believable, specific sample data (company names, numbers, quotes). Never lorem ipsum, never real personal data.
- No captions/headlines describing the app, no logos, no cursor, no device frame.

Animation contract (the page is driven by an external clock):
- Define window.__total = <seconds, 3.5..5> and window.__setT = (t) => {...}.
- __setT(t) must set the ENTIRE visual state for time t purely from t (idempotent, any order). No CSS animations/transitions, no setTimeout/setInterval/requestAnimationFrame, no Date, no Math.random (use fixed values).
- Motion: things enter with eased slide/scale (ease-out / slight overshoot), numbers count up, bars/rings fill, highlights sweep, typing reveals text. Stagger entries. Everything finished and held by ~75% of __total; fade the whole scene out over the last 0.4s so it loops cleanly. Call __setT(0) at the end of your script.
- Everything must stay inside 1920x1080 with >=64px margin. html/body exactly 1920x1080, overflow hidden. No external resources (no fonts, images, CDNs); system-ui fonts, inline SVG for icons.`;

export function isValidDemoAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

export function demoScenePath(appId: string): string {
  return path.join(getPaprDataDir(), "demos", `${appId}.html`);
}

export function hasDemoScene(appId: string): boolean {
  return isValidDemoAppId(appId) && fs.existsSync(demoScenePath(appId));
}

function appDir(appId: string): string {
  return path.join(getPaprAppsRoot(), appId);
}

function readAppCss(dir: string): string {
  for (const f of ["dist/app.css", "style.css", "styles.css"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "";
}

/** The app's title/description + source files (CSS first), within a token budget. */
export function buildDemoScenePrompt(appId: string): string {
  const dir = appDir(appId);
  let meta: { title?: string; description?: string } = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
  } catch {
    /* no metadata */
  }
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const rel = path.relative(dir, p);
      const isDir = fs.statSync(p).isDirectory();
      if (SKIP.test(isDir ? `${rel}/` : rel)) continue;
      if (isDir) walk(p);
      else if (/\.(ts|tsx|js|jsx|html|css)$/.test(f) && !/base\.css$/.test(f)) files.push(rel);
    }
  };
  walk(dir);
  files.sort((a, b) => Number(b.endsWith(".css")) - Number(a.endsWith(".css")));
  let src = "";
  let budget = SOURCE_BUDGET;
  for (const rel of files) {
    const c = fs.readFileSync(path.join(dir, rel), "utf8");
    if (c.length > budget) continue;
    budget -= c.length;
    src += `\n===== ${rel} =====\n${c}`;
  }
  return `App: ${meta.title ?? appId}\nDescription: ${meta.description ?? ""}\n\nSource:${src}`;
}

/** Strip fences/prose, inject the app's CSS, and save privately. */
export function saveDemoScene(appId: string, raw: string): string {
  let html = raw;
  const start = html.search(/<!doctype html>|<html/i);
  if (start > 0) html = html.slice(start);
  html = html.replace(/```\s*$/, "").trim();
  if (!/__setT/.test(html)) throw new Error("Scene is missing window.__setT");
  const css = readAppCss(appDir(appId)).replace(/<\/style/gi, "");
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}<style id="app-css">${css}</style>`)
    : `<style id="app-css">${css}</style>${html}`;
  const file = demoScenePath(appId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return html;
}

/** Player: fit 1920x1080 into the frame and loop __setT on real time. */
const PLAYER = `<script>(function(){function fit(){document.documentElement.style.zoom=String(Math.min(innerWidth/1920,innerHeight/1080))}fit();addEventListener('resize',fit);var s=performance.now();function f(n){var T=window.__total||4;try{window.__setT&&window.__setT(((n-s)/1000)%T)}catch(e){}requestAnimationFrame(f)}requestAnimationFrame(f)})()</script>`;

export function readDemoScene(appId: string, play: boolean): string | null {
  if (!hasDemoScene(appId)) return null;
  const html = fs.readFileSync(demoScenePath(appId), "utf8");
  if (!play) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${PLAYER}</body>`) : html + PLAYER;
}
