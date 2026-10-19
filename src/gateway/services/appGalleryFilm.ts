/**
 * Film an app's gallery/ code (real components) into a demo version.
 *
 * create : the agent writes gallery/ from the app's source → build → film → if it fails
 *          to build, throws, or the layout check finds problems, the agent gets ONE retry
 *          with that feedback (an edit, not a rewrite) → screens from the gallery's own
 *          `screen` declarations (no vision guessing) → gallery/ is saved into the app.
 * revise : the owner's notes become edits to the gallery files; same pipeline.
 *
 * Any failure returns null so appDemoVideos falls back to a written scene: Generate
 * never comes back empty because an app's components can't be filmed.
 */
import * as fs from "fs";
import {
  addVersion,
  demoPaths,
  gallerySnapshotPath,
  markGalleryVersion,
  screenPath,
  screenRawPath,
  setScreens,
  cleanCaption,
  cleanSub,
  type DemoScreen,
} from "./appDemoStore.js";
import {
  GALLERY_DIR,
  buildGallery,
  dropGalleryTakes,
  hasGallery,
  kitSource,
  normalizeGalleryFiles,
  promoteGallery,
  readGalleryFiles,
  writeGalleryFiles,
  type GalleryFile,
} from "./appGallery.js";
import { composeItem } from "./appDemoScreens.js";
import type { DemoDeps, DemoTask, RenderResult } from "./appDemoVideos.js";

export const GALLERY_SYSTEM = `You write an app's GALLERY: a 5-8 second App Store-style preview film made from the app's OWN components, plus the 4-5 gallery screens cut from it.
It lives in the app's code as gallery/index.ts (and optional helpers such as gallery/data.ts). Papr bundles it with the app's modules and films it on a frozen clock.

Rules:
- Import the Papr gallery kit FIRST: import { film, at, ease, enter, typed, lerp } from '/__papr__/papr-gallery.ts';
  It fakes the backend (db queries, backend actions, jobs, live updates) so the app's code runs safely with sample data.
- Then import the sample data module (e.g. import './data';) which calls stub({ query, backend, routes }) — before any app module that loads data.
- Then import the app's REAL modules with relative paths from gallery/ (e.g. import { renderDashboard } from '../dashboard';) and render them with sample data.
  Prefer pure render functions (they return HTML or build DOM from arguments). If a component loads its own data, give it that data through stub() and await it in mount.
  Never copy or re-type the app's markup when a module renders it; reuse it. Never import the app's entry (app.ts/main.ts) or anything that boots the whole app or wires global listeners.
- Sample data: believable and specific (company names, numbers, quotes). Never real people's data, never lorem ipsum.
- film({ scenes }) — 3 to 5 scenes, 1.2-2s each. Each scene: { dur, mount(root), frame?(t, root), screen? }.
  mount builds the scene once from the app's components. frame(t) animates it from t alone (entries with enter(), numbers counting up, typing with typed()); no timers, no Date, no Math.random, no CSS transitions.
  Every animation in a scene finishes by 75% of its dur, so it holds still before the next scene (the screen is captured from that end state).
  The kit scales each scene to fill the 1280x800 frame, so render components at their natural width (about 520-900px wide). One idea per scene: a card, a list, a panel — not the whole app screen.
- Story: the app's core job, input → working → payoff; strongest result first or last.
- screen: { headline, key, sub, shot } on 4 or 5 scenes. headline 2-5 words, benefit or verb first, no app name, no end punctuation; key = the one headline word in the accent colour; sub = one short line (max 9 words); shot = CSS selector of the ONE component in that scene to feature (whole card/list/panel, inside the scene). Each screen a different component.
- Keep each file under 100 lines (split sample data into gallery/data.ts). TypeScript that compiles with esbuild.

Return { files: [{ path: "gallery/index.ts", content }, { path: "gallery/data.ts", content }, ...] }.`;

export const GALLERY_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["files"],
  additionalProperties: false,
} as const;

/** Below this (px on the 1280x800 frame) a label can't be read on a card. */
const GALLERY_MIN_PX = 14;

/** Screens the gallery declares (window.__screens), as the recorder reports them. */
interface DeclaredScreen {
  t: number;
  sel: string;
  caption: string;
  key?: string;
  sub?: string;
}

type GalleryRender = RenderResult & { screens?: DeclaredScreen[]; errors?: string[] };

export interface GalleryDeps {
  /** Ask the agent for gallery files (structured JSON). */
  writeGallery: (appId: string, prompt: string, images?: string[]) => Promise<unknown>;
}

function filesBlock(files: GalleryFile[]): string {
  return files.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n");
}

function createPrompt(appPrompt: string): string {
  return `${appPrompt}\n\n---\n\nPAPR GALLERY KIT (/__papr__/papr-gallery.ts):\n${kitSource()}\n\nWrite the gallery for this app.`;
}

function editGalleryPrompt(appPrompt: string, files: GalleryFile[], requests: string): string {
  return `${appPrompt}\n\n---\n\nPAPR GALLERY KIT (/__papr__/papr-gallery.ts):\n${kitSource()}\n\nCURRENT GALLERY (edit it; do not start over):\n${filesBlock(files)}\n\nCHANGE REQUESTS:\n${requests}\n\nReturn ALL gallery files, edited. Make the smallest change that addresses each request; keep the rest (story, timing, data, screens) unless asked.`;
}

/** Problems worth one retry: build/runtime errors, then layout. */
function filmFeedback(r: GalleryRender | null, buildError: string | null, check: (r: RenderResult) => string | null): string | null {
  if (buildError) return buildError;
  if (!r) return null;
  const lines: string[] = [];
  if (r.errors?.length) lines.push(`The page logged errors while filming:\n- ${r.errors.slice(0, 5).join("\n- ")}`);
  if (!r.screens?.length || r.screens.length < 4) lines.push(`Only ${r.screens?.length ?? 0} scenes declare a screen; 4 or 5 need { headline, key, sub, shot }.`);
  // A film of the real UI keeps the app's own type scale; only flag text that's truly tiny.
  const tiny = r.check.small.filter(([, px]) => px < GALLERY_MIN_PX);
  const layout = check({ ...r, check: { ...r.check, small: tiny.length > 3 ? tiny : [] } });
  if (layout) lines.push(layout.replace(/\(min 22px\)/g, `(under ${GALLERY_MIN_PX}px on the 1280x800 frame)`));
  return lines.length ? lines.join("\n") : null;
}

function score(r: GalleryRender | null): number {
  if (!r) return Infinity;
  return (r.errors?.length ?? 0) * 6 + r.check.small.filter(([, px]) => px < GALLERY_MIN_PX).length + 4 * r.check.offStage.length + 4 * (r.check.overlap?.length ?? 0) + 3 * (r.check.spill?.length ?? 0);
}

/** Write files for a take, build, film. Returns the render, or the build error to feed back. */
async function filmTake(appId: string, deps: DemoDeps, take: string, files: GalleryFile[]): Promise<{ r: GalleryRender | null; error: string | null }> {
  writeGalleryFiles(appId, take, files);
  let html: string;
  try {
    html = (await buildGallery(appId, take)).html;
  } catch (err) {
    return { r: null, error: (err as Error).message };
  }
  const p = demoPaths(appId, take);
  fs.writeFileSync(p.scene, html);
  return { r: (await deps.render({ scenePath: p.scene, videoPath: p.video, posterPath: p.poster })) as GalleryRender, error: null };
}

/** Screens from the gallery's declarations: capture each named component, lay it out. */
async function galleryScreens(appId: string, deps: DemoDeps, v: number, declared: DeclaredScreen[]): Promise<number> {
  if (!deps.stills || !declared.length) return 0;
  try {
    const list = declared.slice(0, 5);
    const scene = demoPaths(appId, `v${v}`).scene;
    const shots = await deps.stills(scene, list.map((s, i) => ({ t: s.t, path: screenRawPath(appId, v, i + 1), snap: true, sel: s.sel })));
    const screens: DemoScreen[] = [];
    list.forEach((s, i) => {
      const shot = shots[i];
      if (!shot || shot.missing) return;
      screens.push({
        t: s.t,
        crop: shot.crop ?? { x: 0, y: 0, w: 1, h: 1 },
        caption: cleanCaption(s.caption) || "Preview",
        ...(s.sub ? { sub: cleanSub(s.sub).replace(/[.!?;:,]+$/, "") } : {}),
        ...(s.key ? { key: s.key.slice(0, 30) } : {}),
        style: "scene",
        ...(shot.tone ? { tone: shot.tone } : {}),
        ...(shot.accent !== undefined ? { accent: shot.accent } : {}),
      });
    });
    // Renumber so file k matches screen k.
    if (screens.length < list.length) {
      const kept = list.map((_, i) => i).filter((i) => !shots[i]?.missing);
      kept.forEach((from, to) => {
        if (from !== to) fs.renameSync(screenRawPath(appId, v, from + 1), screenRawPath(appId, v, to + 1));
      });
    }
    if (screens.length < 3) return 0;
    if (deps.composeScreens) await deps.composeScreens(screens.map((s, i) => composeItem(appId, v, i + 1, s)));
    if (!screens.every((_, i) => fs.existsSync(screenPath(appId, v, i + 1)))) return 0;
    setScreens(appId, v, screens);
    return screens.length;
  } catch (err) {
    console.warn(`[appGallery] screens failed for ${appId}:`, (err as Error).message);
    return 0;
  }
}

function saveSnapshot(appId: string, v: number, files: GalleryFile[]): void {
  fs.writeFileSync(gallerySnapshotPath(appId, v), `${JSON.stringify({ files }, null, 2)}\n`);
  markGalleryVersion(appId, v);
}

/** The gallery files a version was filmed from (snapshot), else the app's gallery/. */
export function galleryFilesFor(appId: string, v: number): GalleryFile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(gallerySnapshotPath(appId, v), "utf8")) as { files?: GalleryFile[] };
    if (raw.files?.length) return raw.files;
  } catch {
    /* none */
  }
  return readGalleryFiles(appId);
}

interface RunOpts {
  kind: "create" | "revise";
  appPrompt: string;
  /** revise: what to change, and the frames the notes point at. */
  requests?: string;
  images?: string[];
  fixedNoteIds?: string[];
  baseVersion?: number;
  check: (r: RenderResult) => string | null;
}

/**
 * One gallery run. Returns the new version, or null to fall back to a written scene.
 * create: if the app already has gallery/ (owner-edited), film it as-is first.
 */
export async function runGallery(appId: string, deps: DemoDeps & GalleryDeps, task: DemoTask, o: RunOpts): Promise<number | null> {
  try {
    let files: GalleryFile[];
    if (o.kind === "revise") {
      const current = galleryFilesFor(appId, o.baseVersion ?? 0);
      if (!current.length) return null;
      task.stage = "revising";
      files = normalizeGalleryFiles(await deps.writeGallery(appId, editGalleryPrompt(o.appPrompt, current, o.requests ?? ""), o.images));
    } else if (hasGallery(appId)) {
      files = readGalleryFiles(appId);
      task.stage = "recording";
    } else {
      task.stage = "writing";
      files = normalizeGalleryFiles(await deps.writeGallery(appId, createPrompt(o.appPrompt)));
    }

    let best = { take: "a", files, ...(await filmTake(appId, deps, "a", files)) };
    const feedback = filmFeedback(best.r, best.error, o.check);
    if (feedback) {
      task.stage = "polishing";
      try {
        const fixed = normalizeGalleryFiles(await deps.writeGallery(appId, editGalleryPrompt(o.appPrompt, files, `Fix these problems from filming it:\n${feedback}`)));
        const second = { take: "b", files: fixed, ...(await filmTake(appId, deps, "b", fixed)) };
        if (score(second.r) < score(best.r)) best = second;
      } catch (err) {
        console.warn(`[appGallery] polish failed for ${appId}:`, (err as Error).message);
      }
    }
    if (!best.r) {
      console.warn(`[appGallery] ${appId}: gallery did not build: ${best.error}`);
      return null;
    }
    const v = addVersion(appId, best.take, o.kind, o.fixedNoteIds ?? []);
    task.stage = "screens";
    await galleryScreens(appId, deps, v, best.r.screens ?? []);
    saveSnapshot(appId, v, best.files);
    // The winning gallery becomes the app's gallery/ (optional source the owner can edit).
    promoteGallery(appId, best.take);
    return v;
  } catch (err) {
    console.warn(`[appGallery] ${appId}: ${(err as Error).message}`);
    return null;
  } finally {
    dropGalleryTakes(appId);
  }
}

export { GALLERY_DIR };
export const _forTests = { filmFeedback, score };
