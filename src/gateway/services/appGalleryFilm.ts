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

export const GALLERY_SYSTEM = `You make an app's Community POSTER FILM: a short loop that shows, sound off and without reading, what changes for the user — plus 3-4 gallery screens cut from it.
It is NOT a screen recording or a tour of the app. It is one designed moment, like an App Store hero card.
It lives in the app's code as gallery/index.ts (+ optional gallery/data.ts, gallery/posters.ts, gallery/poster.css). Papr bundles it with the app's stylesheets and films it on a frozen clock at 1280x800.

STEP 0 — READ THE LISTING: the app name, Community headline, description and brand colours above are what a scroller reads under the film.
  The film must PROVE that headline visually (same promise, same nouns, never contradicting it) and feel like the app's icon and brand.
  Set the film accent to the app's brand colour (the icon / --accent colour) by writing --accent on #papr-film in gallery/poster.css when the app's CSS doesn't already define it.

STEP 1 — FIND THE CHANGE (decide this before any code; write it as a comment at the top of gallery/index.ts):
  BEFORE: the user's world without the app (100 cold invites, an empty week, an unknown website).
  AFTER: the ONE artifact they get (a reply ready to approve, a prep brief, a score with 3 fixes).
  PAYOFF: one concrete line with a number or a name ("9 replied this week", "Prep for Acme is ready").
  SIGNATURE: the ONE visual a fast scroller recognises as THIS app in under a second, even with the text blurred
    (an audit's score ring over a crawled page list, a week calendar with a brief docked to one meeting, a crowd of faces for outreach,
    a pipeline board, a before/after diff, a map, a chart bending up, an inbox sorting itself). Be ambitious: pick the most vivid, specific one.
  Pick the app's most valuable output. Never a settings screen, form, editor, nav or empty state.

STEP 2 — PICK ONE ARCHETYPE for the hero scene (a starting point, not a template — shape it around the SIGNATURE so no two apps' films look alike):
  crowd → one: a grid/list of people or items; a few light up; one is chosen; its focal card pops in beside it. (outreach, recruiting, leads)
  field + toast: a calendar/inbox/board; a result card or toast arrives on it. (scheduling, monitoring, alerts)
  record → enriched: one entity; rows fill in with checks, tags or values. (enrichment, research, CRM)
  score lands: the input; a ring or big number counts up; 2-3 findings appear. (audits, analytics, health)
  stack → pick: cards fanned out; one slides forward and opens. (matching, recommendations)
  before / after: the messy version wipes to the clean one. (writing, cleanup, formatting)

STEP 3 — COMPOSE IT: CONTEXT + ONE FOCUS.
  Background layer = the world (the crowd, the calendar, the list), dimmed or greyscale until it matters.
  Build the SIGNATURE from the app's own most telling components: reuse its real render function, chart, ring, board, timeline,
  message bubble or table row (relative import from gallery/), or match its look exactly with the app's own classes. The pg-* kit is the frame and the
  fallback for plain cards — not the whole film. Prefer big visual objects (rings, charts, grids, timelines, boards, maps) over stacks of text rows.
  Foreground = ONE focal card (max 6 elements) that carries the payoff, usually offset to one side and overlapping the context.
  At every moment exactly one thing is moving and one place to look.
  Real-feeling detail: faces from import { face, faceList } from '/__papr__/papr-faces.ts' (aisha, dana, james, lena, marcus, mei, omar, priya, raj, sofia, theo) as <img class="pg-face">; specific names, roles, companies, times, numbers from the app's domain. Never initials-only avatars, lorem ipsum or real users' data.

STEP 4 — MOTION: ONE ARC.
  Hero scene 5-6s: setup 0-1s (context fades in) → change 1-3s (at most 3 highlights, staggered) → payoff 3-4s (focal card pops in / button resolves) → hold until the end.
  Then 1-2 short follow-up scenes (3-3.5s each, one card each): the payoff's next step (approve → sent) and/or the compounding win (a weekly tip, a trend). Never more than 3 scenes total. The hero must stand alone: it is what the Community card loops.
  Every animation finishes by 70% of its scene's dur; the rest is a still hold (screens are captured there).

STEP 5 — LOOK: THE PAPR DESIGN SYSTEM.
  The app's own components keep their own styling. For anything you build yourself, use the kit's pg-* classes (pg-card, pg-kicker, pg-hero, pg-title, pg-text, pg-muted, pg-item, pg-row, pg-chip, pg-btn, pg-avatar, pg-face, pg-bar, pg-toast).
  Colours come only from the app's own styles, the pg-* classes and the app accent (var(--pg-accent)); a success state may use var(--pg-ok). Never invent hex colours; text always contrasts with what it sits on.
  film({ theme, transition: 'lift', fade: 0.9, scenes }) — theme matches the app's own look ('dark' or 'light'). No background option (the kit draws it).
  Generous whitespace; text >= 20px; one composition ~900-1150px wide, centred.

STEP 6 — SCREENS: screen: { headline, key, sub, shot } on every scene (3-4 total; you may add a second screen on the hero by splitting it into two scenes only if both read on their own).
  headline 2-5 words about the OUTCOME that echo the listing headline (don't repeat it verbatim), never a feature name, no app name, no end punctuation ("Warm intros while you sleep", "Walk in prepared"). key = the one headline word in the accent colour. sub = max 9 words. shot = CSS selector of the whole composition or focal card in that scene.

STEP 7 — SELF-CHECK before returning (fix and simplify if any fails):
  A stranger knows what the app does after 3s? Blur the text: is it still obviously THIS app? Swap in another app's words: would the film still fit? (then the SIGNATURE is too generic — make it bigger and more specific.) One place to look at every moment? The film ends on a payoff? No scene looks like a full app screen? Every colour from pg-* / accent?

Code rules:
- First line: import { film, at, ease, enter, typed, lerp } from '/__papr__/papr-gallery.ts'; (it fakes the backend so app modules are safe to import).
- You MAY reuse a small pure render function from the app (relative import from gallery/) if it IS the focal card; otherwise build posters from pg-* markup. Never import the app's entry (app.ts/main.ts) or anything that boots the app.
- Each scene: { dur, mount(root), frame?(t, root), screen? }. mount builds DOM once; frame(t) animates from t alone (at(), enter(), typed(), lerp()). No timers, Date, Math.random, CSS transitions or CSS animations.
- Each file under 100 lines; TypeScript that compiles with esbuild.

Return { files: [{ path: "gallery/index.ts", content }, ...] }.`;

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
  if (!r.screens?.length || r.screens.length < 3) lines.push(`Only ${r.screens?.length ?? 0} scenes declare a screen; 3 or 4 need { headline, key, sub, shot }.`);
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
