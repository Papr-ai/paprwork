/**
 * App preview videos — quality: what the agent looks at and how a take is judged.
 *
 * Learned from Launch Video Studio (14 iterations of a launch video): the writer can't
 * see its own output, so a reviewer that *looks* at rendered frames catches what a DOM
 * check can't (blank pieces, clutter, a scene that doesn't read as this app). Fixes are
 * edits to the same scene, never a rewrite, so what was already good stays good.
 *
 * Fidelity, not copying: the reviewer also gets a screenshot of the real app (the
 * owner's private cover) and judges whether the scene *feels* like that app — palette,
 * type, component shapes, wording on buttons and headings — while the data is invented.
 * Nothing from the screenshot's data may appear in the scene; it never leaves this
 * machine except to the user's own model provider, like any screenshot in chat.
 */
import * as fs from "fs";
import { privateCoverPath, sniffImageType } from "./appCovers.js";
import { demoDir } from "./appDemoStore.js";
import * as path from "path";

/** Seconds of the loop to look at, as fractions of its length (entry, story, payoff). */
export const REVIEW_AT = [0.18, 0.45, 0.72] as const;

export interface ReviewProblem {
  /** 1-based frame number, 0 = the whole scene. */
  frame: number;
  what: string;
  fix: string;
}

export interface SceneReview {
  /** 1-5: does it look like *this* app (palette, type, components, wording)? */
  fidelity: number;
  /** 1-5: readable at card size, clean layout, a clear payoff. */
  polish: number;
  problems: ReviewProblem[];
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    fidelity: { type: "integer", minimum: 1, maximum: 5 },
    polish: { type: "integer", minimum: 1, maximum: 5 },
    problems: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          frame: { type: "integer", minimum: 0 },
          what: { type: "string" },
          fix: { type: "string" },
        },
        required: ["frame", "what", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["fidelity", "polish", "problems"],
  additionalProperties: false,
} as const;

export function reviewPrompt(appTitle: string, hasReference: boolean, times: number[]): string {
  const frames = times.map((t, i) => `frame ${i + 1} = ${t.toFixed(1)}s`).join(", ");
  return `You are the QA reviewer for a 4-second looping preview video of the app "${appTitle}". It plays as a card cover about 460px wide.
${hasReference ? "The FIRST image is a screenshot of the real app (reference only — it holds the owner's real data). The next images are" : "The images are"} frames from the preview: ${frames}.

Judge it like an App Store editor. Report only real problems, concrete (which element, where) with a concrete fix. No praise.
Readability and polish:
- text too small to read at card size, clipped, touching an edge, or overlapping other text
- blank, broken or half-rendered pieces; empty boxes; placeholder text ("Lorem", "Item 1", "Sample")
- clutter: more than ~3 pieces of UI, or a frame where the eye doesn't know where to look
- no clear story: you can't tell what the app does, or the payoff (result, score, list, draft) isn't the hero
- motion state that looks wrong mid-way (half-faded text on top of other text)
${hasReference ? `Fidelity to the real app (it should feel like the same product, not a generic template):
- colours, fonts, corner radius, card and button style differ from the reference
- labels, headings, button text or icons don't match the app's own words and components
- ANY name, number or sentence copied from the reference screenshot's data (it must be invented) — always a problem
` : ""}Scores: fidelity 1-5 (5 = unmistakably this app${hasReference ? "" : "; judge from the app name and style alone"}), polish 1-5 (5 = ready to feature).
Frame numbers in problems are 1-based; use 0 for the whole scene.`;
}

/** Copy the owner's private cover (a real screenshot) next to the scratch files with the right extension. */
export function referenceImage(appId: string): string | null {
  try {
    const buf = fs.readFileSync(privateCoverPath(appId));
    const mime = sniffImageType(buf);
    const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "";
    if (!ext) return null;
    const out = path.join(demoDir(), `${appId}.ref.${ext}`);
    fs.mkdirSync(demoDir(), { recursive: true });
    fs.writeFileSync(out, buf);
    return out;
  } catch {
    return null;
  }
}

export function normalizeReview(raw: unknown): SceneReview | null {
  const r = raw as Partial<SceneReview> | null;
  if (!r || typeof r !== "object") return null;
  const clamp = (n: unknown) => (typeof n === "number" ? Math.min(5, Math.max(1, Math.round(n))) : 3);
  const problems = Array.isArray(r.problems)
    ? r.problems
        .filter((p): p is ReviewProblem => !!p && typeof p.what === "string" && p.what.trim().length > 0)
        .slice(0, 8)
        .map((p) => ({ frame: Number(p.frame) || 0, what: p.what.trim(), fix: String(p.fix ?? "").trim() }))
    : [];
  return { fidelity: clamp(r.fidelity), polish: clamp(r.polish), problems };
}

/** Fix-list for the writer, or null when the take is good enough to keep. */
export function reviewFeedback(review: SceneReview | null, times: number[]): string | null {
  if (!review) return null;
  const good = review.problems.length === 0 && review.fidelity >= 4 && review.polish >= 4;
  if (good) return null;
  const at = (f: number) => (f > 0 && times[f - 1] !== undefined ? `at ${times[f - 1]!.toFixed(1)}s` : "overall");
  const lines = review.problems.map((p) => `- ${at(p.frame)}: ${p.what}${p.fix ? ` → ${p.fix}` : ""}`);
  if (review.fidelity < 4) {
    lines.push(`- Fidelity ${review.fidelity}/5: make it feel more like the real app — its own colours, fonts, component shapes and wording (copy class names and markup from its code). Keep the data invented.`);
  }
  if (review.polish < 4 && !review.problems.length) {
    lines.push(`- Polish ${review.polish}/5: fewer, bigger pieces; one clear payoff.`);
  }
  return lines.join("\n");
}

/** Lower is better. A review counts more than the DOM check: it sees what the viewer sees. */
export function reviewScore(review: SceneReview | null): number {
  if (!review) return 0;
  return 3 * review.problems.length + 4 * (5 - review.fidelity) + 4 * (5 - review.polish);
}
