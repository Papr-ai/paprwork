/**
 * App preview videos — a 3–5s looping MP4 that shows what an app does, used as the
 * app's cover (library cards, App info, Community when the owner shares it).
 *
 * Pipeline (one task per app, runs in the background):
 *   1. write   — the Papr agent (AgentService) reads the app's code and writes a scene:
 *                self-contained HTML on a 1280x800 stage, reusing the app's own
 *                components/CSS with invented sample data, driven by window.__setT(t).
 *                Model, auth (OAuth / API key / Papr proxy) and fallbacks are Paprwork's.
 *   2. record  — Electron renders the scene offscreen on a frozen clock and encodes an
 *                H.264 MP4 + poster JPEG with WebCodecs (src/electron/ipc/appDemoRender.cjs).
 *   3. polish  — if the layout check finds text too small to read on a card or content
 *                off the frame, the agent gets one retry with that feedback; the better
 *                take wins.
 *
 * Files live privately in <papr>/data/demos/ (gitignored, never synced):
 *   {appId}.html (scene, kept for re-rendering), {appId}.mp4, {appId}.jpg (poster).
 * Sample data only, so — unlike screenshots — the video is safe to share by default;
 * sharing still goes through the owner's App info choice (appCovers.sharePrivateCover).
 */
import * as fs from "fs";
import * as path from "path";
import { getPaprAppsRoot, getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  readSharedCoverPointer,
  sharedCoverPath,
  sharedCoverPointerPath,
  type CoverUploader,
  type SharedCoverPointer,
} from "./appCovers.js";

export const DEMO_STAGE = { width: 1280, height: 800 } as const;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_BUDGET = 90_000;
const SKIP = /node_modules|(^|\/)dist\/|__papr__|\.d\.ts$|(^|\/)assets\/|(^|\/)content\//;
/** More than this many unreadable labels triggers the one polish retry. */
const MAX_SMALL_LABELS = 2;

export const DEMO_SCENE_SYSTEM = `You design App Store-style animated preview loops for small web apps ("mini-apps").
You get the app's source. Produce ONE self-contained HTML file: a 1280x800 scene that shows what the app does in 3-5 seconds, like an iOS App Store preview. It is shown as a card cover around 460px wide, so it must read at a glance.

How it should look:
- NOT a screen recording or full screenshot. Compose 1-3 floating pieces of the app's real UI (cards, scores, table rows, charts, chips, inputs) on a soft gradient background that fits the app's palette. Generous whitespace, soft large shadows, rounded corners.
- Reuse the app's own components: copy markup structure and class names from its view code; its CSS is injected for you as <style id="app-css">. Then make everything BIG: every visible label at least 22px, body text 24-30px, key numbers 56-120px. Raise font sizes directly (or scale a wrapper) — the app's own 12-14px sizes are far too small here. Fewer elements, bigger, beats more elements, smaller.
- Layout must be clean, like a finished product shot:
  * Lay out with flexbox/grid. Never absolutely position text on top of other text; no two labels may overlap at any moment.
  * Every label fits inside the shape that holds it. Text inside a ring/circle/pill must be shorter than ~60% of its width — use a short label ("74%" + "margin") or put the label below the shape.
  * Don't stack or crossfade two different text blocks in the same spot; show one, then replace it only after the first is fully gone.
  * Lines, charts and dividers never cross text — give charts their own box with padding.
- Show the app's core job as a tiny story: input -> the app working -> the payoff (score, insight, list, chart, draft...). The payoff is the hero.
- Invent believable, specific sample data (company names, numbers, quotes). Never lorem ipsum, never real personal data.
- No captions describing the app, no logos, no cursor, no device frame, no emoji.

Animation contract (the page is filmed frame by frame on a frozen clock):
- Define window.__total = <seconds, 3.5..5> and window.__setT = (t) => {...}.
- __setT(t) sets the ENTIRE visual state for time t purely from t (idempotent, any order). No CSS animations/transitions, no setTimeout/setInterval/requestAnimationFrame, no Date, no Math.random.
- Motion: eased slide/scale entries (ease-out, slight overshoot), numbers count up, bars/rings fill, highlights sweep, typing reveals text. Stagger entries. Everything settled by ~75% of __total; fade the whole scene out over the last 0.4s so it loops cleanly. Call __setT(0) at the end of your script.
- html/body exactly 1280x800, margin 0, overflow hidden. Everything stays inside with >=40px margin. No external resources (fonts, images, CDNs); system-ui fonts, inline SVG icons.`;

export function isValidDemoAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

export function demoDir(): string {
  return path.join(getPaprDataDir(), "demos");
}

export function demoPaths(appId: string, take = "") {
  const base = path.join(demoDir(), `${appId}${take ? `.${take}` : ""}`);
  return { scene: `${base}.html`, video: `${base}.mp4`, poster: `${base}.jpg` };
}

export function hasDemoVideo(appId: string): boolean {
  return isValidDemoAppId(appId) && fs.existsSync(demoPaths(appId).video);
}

/** Every app with a finished preview video (one call for the whole library). */
export function listDemoAppIds(): string[] {
  try {
    return fs
      .readdirSync(demoDir())
      .filter((f) => /^[A-Za-z0-9_-]+\.mp4$/.test(f))
      .map((f) => f.slice(0, -4))
      .filter(isValidDemoAppId);
  } catch {
    return [];
  }
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

/** The app's title/description + source files (CSS first), within a size budget. */
export function buildDemoScenePrompt(appId: string): string {
  const dir = appDir(appId);
  if (!fs.existsSync(dir)) throw new Error("App not found");
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

/** Strip fences/prose, check the animation contract, inject the app's CSS. */
export function normalizeScene(appId: string, raw: string): string {
  let html = raw;
  const start = html.search(/<!doctype html>|<html/i);
  if (start > 0) html = html.slice(start);
  html = html.replace(/```\s*$/, "").trim();
  if (!/<html|<!doctype/i.test(html)) throw new Error("The model returned no scene.");
  if (!/__setT/.test(html)) throw new Error("The scene has no animation clock (window.__setT).");
  const css = readAppCss(appDir(appId)).replace(/<\/style/gi, "");
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}<style id="app-css">${css}</style>`)
    : `<style id="app-css">${css}</style>${html}`;
}

export interface RenderCheck {
  /** [label, effective px on the 1280x800 frame] */
  small: [string, number][];
  offStage: string[];
  /** Text wider than the shape that holds it. */
  spill?: string[];
  /** Two visible labels on top of each other ("a" on "b"). */
  overlap?: string[];
}

export interface RenderResult {
  seconds: number;
  frames: number;
  codec: string;
  bytes: number;
  check: RenderCheck;
}

/** Feedback for the polish retry, or null when the take is good. */
export function checkFeedback(check: RenderCheck): string | null {
  const lines: string[] = [];
  if (check.small.length > MAX_SMALL_LABELS) {
    const sample = check.small.slice(0, 8).map(([t, px]) => `"${t}" (${px}px)`).join(", ");
    lines.push(
      `${check.small.length} labels are too small to read on a card (min 22px): ${sample}. Make them much bigger, or drop them.`,
    );
  }
  if (check.overlap?.length) {
    lines.push(`Text overlaps other text: "${check.overlap.slice(0, 5).join('", "')}". Give each piece its own space (flex/grid), never stack text.`);
  }
  if (check.spill?.length) {
    lines.push(`Text spills out of its shape: ${check.spill.slice(0, 5).map((t) => `"${t}"`).join(", ")}. Shorten it or make the shape bigger.`);
  }
  if (check.offStage.length) {
    lines.push(`Content is outside the 1280x800 frame: ${check.offStage.slice(0, 5).map((t) => `"${t}"`).join(", ")}. Keep everything inside with 40px margin.`);
  }
  return lines.length ? lines.join("\n") : null;
}

function checkScore(check: RenderCheck): number {
  return check.small.length + 4 * check.offStage.length + 4 * (check.overlap?.length ?? 0) + 3 * (check.spill?.length ?? 0);
}

export type DemoStage = "writing" | "recording" | "polishing";

export interface DemoTask {
  state: "running" | "done" | "failed";
  stage?: DemoStage;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface DemoDeps {
  /** Ask the Papr agent for scene HTML. */
  writeScene: (appId: string, prompt: string) => Promise<string>;
  /** Record the scene to MP4 + poster (Electron). */
  render: (paths: { scenePath: string; videoPath: string; posterPath: string }) => Promise<RenderResult>;
  /** Called after a new video is in place (e.g. notify the UI). */
  onDone?: (appId: string) => void;
}

const tasks = new Map<string, DemoTask>();

export function demoStatus(appId: string): { exists: boolean; updatedAt: number | null; task: DemoTask | null } {
  let updatedAt: number | null = null;
  try {
    updatedAt = fs.statSync(demoPaths(appId).video).mtimeMs;
  } catch {
    /* none yet */
  }
  return { exists: updatedAt !== null, updatedAt, task: tasks.get(appId) ?? null };
}

/** Start (or join) the background generation for one app. */
export function startDemoGeneration(appId: string, deps: DemoDeps): DemoTask {
  if (!isValidDemoAppId(appId)) throw new Error("invalid appId");
  const current = tasks.get(appId);
  if (current?.state === "running") return current;
  const task: DemoTask = { state: "running", stage: "writing", startedAt: Date.now() };
  tasks.set(appId, task);
  void runGeneration(appId, deps, task);
  return task;
}

function removeTake(appId: string, take: string): void {
  for (const f of Object.values(demoPaths(appId, take))) fs.rmSync(f, { force: true });
}

async function takeOnce(
  appId: string,
  deps: DemoDeps,
  take: string,
  prompt: string,
): Promise<RenderResult> {
  const html = normalizeScene(appId, await deps.writeScene(appId, prompt));
  const p = demoPaths(appId, take);
  fs.writeFileSync(p.scene, html);
  return deps.render({ scenePath: p.scene, videoPath: p.video, posterPath: p.poster });
}

async function runGeneration(appId: string, deps: DemoDeps, task: DemoTask): Promise<void> {
  fs.mkdirSync(demoDir(), { recursive: true });
  const prompt = buildDemoScenePromptSafe(appId);
  try {
    if (prompt instanceof Error) throw prompt;
    task.stage = "writing";
    const first = await takeOnce(appId, deps, "a", prompt);
    let winner = "a";
    const feedback = checkFeedback(first.check);
    if (feedback) {
      task.stage = "polishing";
      try {
        const second = await takeOnce(
          appId,
          deps,
          "b",
          `${prompt}\n\nYOUR PREVIOUS ATTEMPT HAD PROBLEMS — fix them:\n${feedback}`,
        );
        if (checkScore(second.check) < checkScore(first.check)) winner = "b";
      } catch (err) {
        // Keep the first take; a failed polish is not a failed video.
        console.warn(`[appDemoVideos] polish retry failed for ${appId}:`, (err as Error).message);
      }
    }
    const from = demoPaths(appId, winner);
    const to = demoPaths(appId);
    fs.renameSync(from.scene, to.scene);
    fs.renameSync(from.poster, to.poster);
    fs.renameSync(from.video, to.video); // last: the .mp4 is what marks a finished video
    task.state = "done";
    deps.onDone?.(appId);
  } catch (err) {
    task.state = "failed";
    task.error = (err as Error).message || "Couldn't make a preview video.";
  } finally {
    task.stage = undefined;
    task.finishedAt = Date.now();
    removeTake(appId, "a");
    removeTake(appId, "b");
  }
}

// Recording happens after writing; expose the stage switch for the default render dep.
export function markRecording(appId: string): void {
  const t = tasks.get(appId);
  if (t?.state === "running" && t.stage !== "polishing") t.stage = "recording";
}

function buildDemoScenePromptSafe(appId: string): string | Error {
  try {
    return buildDemoScenePrompt(appId);
  } catch (err) {
    return err as Error;
  }
}

/** Test hook. */
export function _resetDemoTasks(): void {
  tasks.clear();
}

// ── Sharing ────────────────────────────────────────────────────────────────
// The owner picks "Preview video" as the cover in App info. The video and its poster
// become App Files (CDN-public) and papr-cover.json points at them: `url` is the poster
// (image consumers keep working), `videoUrl` the loop. Text only, so git sync carries it.


export interface SharedVideoPointer extends SharedCoverPointer {
  kind: "video";
  videoUrl: string;
  videoFileId: string;
  videoObjectKey?: string;
}

export function sharedCoverKind(appId: string): "video" | "image" | null {
  const p = readSharedCoverPointer(appId) as Partial<SharedVideoPointer> | null;
  if (p?.kind === "video" && p.videoUrl) return "video";
  if (p || fs.existsSync(sharedCoverPath(appId))) return "image";
  return null;
}

export async function shareDemoVideo(
  appId: string,
  upload: CoverUploader,
): Promise<{ shared: true; url: string; videoUrl: string } | { shared: false; reason: string }> {
  if (!isValidDemoAppId(appId)) return { shared: false, reason: "invalid_app" };
  const p = demoPaths(appId);
  if (!fs.existsSync(p.video) || !fs.existsSync(p.poster)) return { shared: false, reason: "no_video" };
  // Dedicated copies: re-making the private video never changes what was shared.
  const video = path.join(demoDir(), `${appId}.shared.mp4`);
  const poster = path.join(demoDir(), `${appId}.shared.jpg`);
  fs.copyFileSync(p.video, video);
  fs.copyFileSync(p.poster, poster);
  const v = await upload({ appId, filePath: video, fileName: "preview.mp4", mime: "video/mp4" });
  const i = await upload({ appId, filePath: poster, fileName: "preview.jpg", mime: "image/jpeg" });
  const pointer: SharedVideoPointer = {
    kind: "video",
    appFileId: i.id,
    objectKey: i.objectKey,
    url: i.url,
    videoFileId: v.id,
    videoObjectKey: v.objectKey,
    videoUrl: v.url,
  };
  fs.writeFileSync(sharedCoverPointerPath(appId), `${JSON.stringify(pointer, null, 2)}\n`);
  fs.rmSync(sharedCoverPath(appId), { force: true });
  return { shared: true, url: i.url, videoUrl: v.url };
}
