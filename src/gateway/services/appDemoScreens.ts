/**
 * Gallery screens: five moments of the preview, each laid out like a Launch Video Studio
 * scene — a headline (key word in the accent) and one supporting line over the real
 * component, floating large on a calm background in the app's colours.
 *
 * Runs after a video version is made, from the same scene (sample data only):
 *   1. contact sheet — frames at even moments of the loop (Electron stills).
 *   2. pick          — a vision model picks 5 moments, marks the ONE component in each and
 *                      writes the headline + line (SCREENS_PROMPT). It only picks; Papr lays out.
 *   3. capture       — each component is snapped to its real element box and captured sharp.
 *   4. compose       — Papr lays out each screen and saves the finished image (Electron).
 * A failed or partial pick never fails the video: the gallery just has no screens yet.
 */
import * as fs from "fs";
import {
  MAX_SCREENS,
  cleanCaption,
  cleanSub,
  demoPaths,
  screenPath,
  setScreens,
  screenRawPath,
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
Each screen is laid out like a launch-video scene: a big headline, one supporting line, and ONE real piece of the app floating large below them.
1. Pick 5 moments. Each shows ONE thing a person gets. Strongest result first, key actions next, sharing or settings last.
   Skip loading, empty or half-open states, toasts, menus, dialogs, mid-animation frames, and anything that looks like personal data.
   Each screen shows a different component; never the same card twice.
2. For each moment, mark the ONE whole component that shows it: a card, a list, a chart, a panel. Never the whole frame, never half a card.
   The box (x, y, w, h as fractions 0..1 of the frame) should hug that component's edges; Papr snaps it to the element.
   Prefer components with about 3 to 6 elements that are big enough to read.
3. Headline: 2 to 5 words, leads with the benefit or a verb, no app name, no end punctuation. key = the one word of the headline to put in the accent colour.
4. Line: one short sentence (max 9 words) that says what the person gets. Plain words, no jargon, no end punctuation.
Layout is fixed by Papr, not by you.`;

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
          key: { type: "string" },
          sub: { type: "string" },
          why: { type: "string" },
        },
        required: ["frame", "crop", "caption", "key", "sub", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["screens"],
  additionalProperties: false,
} as const;

export interface ScreenStill {
  t: number;
  path: string;
  /** Snap captures: the frame's average colour and accent, [r, g, b]. */
  tone?: number[];
  accent?: number[] | null;
}

/** One screen to lay out: the captured component (raw) → the finished image (path). */
export interface ComposeItem {
  raw: string;
  path: string;
  caption: string;
  sub?: string;
  key?: string;
  tone?: number[];
  accent?: number[] | null;
  radius?: number;
}

export interface ScreenDeps {
  stills: (scenePath: string, stills: { t: number; path: string; crop?: DemoCrop; snap?: boolean }[]) => Promise<ScreenStill[]>;
  pick: (prompt: string, images: string[]) => Promise<unknown>;
  /** Lay out scene-style screens. Without it, screens are the older bare crops. */
  compose?: (items: ComposeItem[]) => Promise<void>;
}

export function composeItem(appId: string, v: number, k: number, s: DemoScreen): ComposeItem {
  return {
    raw: screenRawPath(appId, v, k),
    path: screenPath(appId, v, k),
    caption: s.caption,
    ...(s.sub ? { sub: s.sub } : {}),
    ...(s.key ? { key: s.key } : {}),
    ...(s.tone ? { tone: s.tone } : {}),
    ...(s.accent !== undefined ? { accent: s.accent } : {}),
    ...(s.radius != null ? { radius: s.radius } : {}),
  };
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
    const p = item as { frame?: unknown; crop?: unknown; caption?: unknown; key?: unknown; sub?: unknown; why?: unknown };
    const t = times[Number(p.frame) - 1];
    const crop = normalizeCrop(p.crop);
    const caption = typeof p.caption === "string" ? cleanCaption(p.caption) : "";
    if (t === undefined || !crop || !caption) continue;
    const sub = typeof p.sub === "string" ? cleanSub(p.sub).replace(/[.!?;:,]+$/, "") : "";
    const key = typeof p.key === "string" ? p.key.trim().slice(0, 30) : "";
    out.push({
      t, crop, caption,
      ...(sub ? { sub } : {}),
      ...(key ? { key } : {}),
      ...(typeof p.why === "string" && p.why ? { why: p.why.slice(0, 200) } : {}),
    });
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
    if (deps.compose) {
      const shots = await deps.stills(scene, screens.map((s, i) => ({ t: s.t, path: screenRawPath(appId, v, i + 1), crop: s.crop, snap: true })));
      screens.forEach((s, i) => {
        s.style = "scene";
        if (shots[i]?.tone) s.tone = shots[i]!.tone;
        if (shots[i]?.accent !== undefined) s.accent = shots[i]!.accent;
      });
      await deps.compose(screens.map((s, i) => composeItem(appId, v, i + 1, s)));
    } else {
      await deps.stills(scene, screens.map((s, i) => ({ t: s.t, path: screenPath(appId, v, i + 1), crop: s.crop })));
    }
    // All or nothing: file k must match screen k.
    if (!screens.every((_, i) => fs.existsSync(screenPath(appId, v, i + 1)))) return 0;
    setScreens(appId, v, screens);
    return screens.length;
  } catch (err) {
    console.warn(`[appDemoScreens] screens failed for ${appId}:`, (err as Error).message);
    return 0;
  }
}
