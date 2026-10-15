/**
 * Gallery screens: five cropped moments of the preview, each under a short caption.
 *
 * Runs after a video version is made, from the same scene (sample data only):
 *   1. contact sheet — frames at even moments of the loop (Electron stills).
 *   2. pick          — a vision model picks 5 moments, crops each to ONE region and writes
 *                      a 2-5 word caption (SCREENS_PROMPT). It only picks; Papr owns the layout.
 *   3. crop          — each pick is re-captured at its moment and cropped (Electron).
 * A failed or partial pick never fails the video: the gallery just has no screens yet.
 */
import * as fs from "fs";
import {
  MAX_SCREENS,
  cleanCaption,
  demoPaths,
  screenPath,
  setScreens,
  stillPath,
  versionTake,
  type DemoCrop,
  type DemoScreen,
} from "./appDemoStore.js";

/** Frames the picker looks at, as fractions of the loop. */
export const SHEET_AT = [0.12, 0.25, 0.38, 0.5, 0.62, 0.72, 0.8, 0.88] as const;
/** A crop narrower than this can't be read once scaled to a 560px card. */
const MIN_CROP = 0.25;

export const SCREENS_PROMPT = `You make the 5 gallery screens for a Papr app from frames of its sample-data preview. Frame k is at the time listed for it.
1. Pick 5 moments. Each shows ONE thing a person gets. Strongest result first, key actions next, sharing or settings last.
   Skip loading, empty or half-open states, toasts, menus, dialogs, mid-animation frames, and anything that looks like personal data.
2. For each moment, crop to the ONE region that shows it: a card, a list, a chart, a button and its result. Never the whole frame.
   The crop must stay readable at 560px wide: body text at least 14px after scaling. If it isn't, crop tighter.
   Keep it to about 3 to 6 elements. If the region is busier than that, pick a smaller region or a different moment.
   Crop is x, y, w, h as fractions (0..1) of the frame; aspect about 16:10 or wider.
3. Write a caption: 2 to 5 words, leads with the benefit or a verb, no app name, no end punctuation.
Layout is fixed by Papr, not by you: 16:10 card, soft tint, caption top-left inside the card, crop below it.`;

export const SCREENS_SCHEMA = {
  type: "object",
  properties: {
    screens: {
      type: "array",
      maxItems: MAX_SCREENS,
      items: {
        type: "object",
        properties: {
          frame: { type: "integer", minimum: 1 },
          crop: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
          },
          caption: { type: "string" },
          why: { type: "string" },
        },
        required: ["frame", "crop", "caption", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["screens"],
  additionalProperties: false,
} as const;

export interface ScreenDeps {
  stills: (scenePath: string, stills: { t: number; path: string; crop?: DemoCrop }[]) => Promise<{ t: number; path: string }[]>;
  pick: (prompt: string, images: string[]) => Promise<unknown>;
}

const unit = (n: unknown, lo = 0) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(lo, n)) : null);

/** Keep crops inside the frame and big enough to read. */
export function normalizeCrop(raw: unknown): DemoCrop | null {
  const c = raw as Partial<DemoCrop> | null;
  const w = unit(c?.w, MIN_CROP);
  const h = unit(c?.h, MIN_CROP * 0.6);
  const x = unit(c?.x);
  const y = unit(c?.y);
  if (w === null || h === null || x === null || y === null) return null;
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h };
}

/** Model output → up to 5 screens with times; drops anything unusable. */
export function normalizeScreens(raw: unknown, times: number[]): DemoScreen[] {
  const list = (raw as { screens?: unknown[] } | null)?.screens;
  if (!Array.isArray(list)) return [];
  const out: DemoScreen[] = [];
  for (const item of list) {
    const p = item as { frame?: unknown; crop?: unknown; caption?: unknown; why?: unknown };
    const t = times[Number(p.frame) - 1];
    const crop = normalizeCrop(p.crop);
    const caption = typeof p.caption === "string" ? cleanCaption(p.caption) : "";
    if (t === undefined || !crop || !caption) continue;
    out.push({ t, crop, caption, ...(typeof p.why === "string" && p.why ? { why: p.why.slice(0, 200) } : {}) });
    if (out.length === MAX_SCREENS) break;
  }
  return out;
}

/** Make the gallery screens for one version. Returns how many were made (0 on failure). */
export async function makeScreens(appId: string, v: number, seconds: number, deps: ScreenDeps, notes = ""): Promise<number> {
  const scene = demoPaths(appId, versionTake(v)).scene;
  const times = SHEET_AT.map((f) => Math.round(f * seconds * 10) / 10);
  try {
    const sheet = await deps.stills(scene, times.map((t, i) => ({ t, path: stillPath(appId, `g${i}`) })));
    const listed = times.map((t, i) => `frame ${i + 1} = ${t.toFixed(1)}s`).join(", ");
    const owner = notes ? `\n\nThe owner left these notes on the previous screens. Follow them:\n${notes}` : "";
    const raw = await deps.pick(`${SCREENS_PROMPT}\n\nFrames: ${listed}.${owner}`, sheet.map((s) => s.path));
    const screens = normalizeScreens(raw, times);
    if (!screens.length) return 0;
    await deps.stills(scene, screens.map((s, i) => ({ t: s.t, path: screenPath(appId, v, i + 1), crop: s.crop })));
    // All or nothing: file k must match screen k.
    if (!screens.every((_, i) => fs.existsSync(screenPath(appId, v, i + 1)))) return 0;
    setScreens(appId, v, screens);
    return screens.length;
  } catch (err) {
    console.warn(`[appDemoScreens] screens failed for ${appId}:`, (err as Error).message);
    return 0;
  }
}
