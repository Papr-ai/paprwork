/**
 * Goal-directed browsing loop used by browser_goto.
 *
 * Each step: extract the page → Jev scores sections + elements against the goal →
 * stop if a section clearly answers it, otherwise follow the best unvisited link.
 * No LLM calls: the calling agent reads the returned passages and writes the answer.
 */
import {
  EXTRACT_PAGE_SCRIPT,
  buildSections,
  formatElement,
  rankAgainstGoal,
  refSelector,
  type ItemScorer,
  type PageElement,
  type PageSection,
  type RawExtraction,
} from "./pageExtract.js";

export interface GotoPage {
  url(): string;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  /** Wait for the page to settle after navigation/click. */
  settle(): Promise<void>;
}

export interface GotoOptions {
  maxSteps?: number;
  /** Section score (0-3) that counts as "found". */
  stopScore?: number;
  /** Minimum element score worth following. */
  minLinkScore?: number;
  /** Allow following links to other sites (default: same site incl. subdomains). */
  allowOffsite?: boolean;
  scorer?: ItemScorer;
}

export interface GotoPassage {
  url: string;
  path: string;
  text: string;
  score: number;
}

export interface GotoStep {
  url: string;
  bestScore: number;
  /** How we left this page (absent on the last step). */
  followed?: { ref: number; text: string; href?: string; score: number };
  error?: string;
}

export interface GotoResult {
  found: boolean;
  confidence: "high" | "medium" | "low";
  passages: GotoPassage[];
  steps: GotoStep[];
  finalUrl: string;
  /** Top-scoring elements on the final page, for the agent's next move. */
  elements: string[];
  stopReason: "found" | "max_steps" | "no_promising_links" | "extract_failed";
}

const UNSAFE_LINK = /log ?out|sign ?out|unsubscribe|delete|remove|cancel (plan|subscription)/i;
const FOLLOWABLE_KINDS = new Set(["link", "tab", "summary"]);

export function siteKey(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
    return parts.slice(-2).join(".");
  } catch {
    return url;
  }
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

interface Candidate {
  el: PageElement;
  score: number;
  fromUrl: string;
}

export async function runGoto(page: GotoPage, goal: string, opts: GotoOptions = {}): Promise<GotoResult> {
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? 5, 1), 8);
  const stopScore = opts.stopScore ?? 2.3;
  const minLinkScore = opts.minLinkScore ?? 1.0;
  const startSite = siteKey(page.url());
  const visited = new Set<string>([normalize(page.url())]);
  const pool = new Map<string, Candidate>();
  const passages: GotoPassage[] = [];
  const steps: GotoStep[] = [];
  let lastElements: string[] = [];
  let stopReason: GotoResult["stopReason"] = "max_steps";

  for (let step = 0; step < maxSteps; step++) {
    const url = page.url();
    let raw: RawExtraction | null = null;
    try {
      raw = (await page.evaluate(EXTRACT_PAGE_SCRIPT)) as RawExtraction;
    } catch {
      raw = null;
    }
    if (!raw || !Array.isArray(raw.blocks)) {
      steps.push({ url, bestScore: 0, error: "could not read page" });
      stopReason = "extract_failed";
      break;
    }
    const sections: PageSection[] = buildSections(raw.blocks);
    const ranking = await rankAgainstGoal(goal, sections, raw.elements, url, {
      scorer: opts.scorer,
      topSections: 5,
      topElements: 40,
    });
    for (const s of ranking.sections) passages.push({ url, path: s.path, text: s.text, score: s.score });
    lastElements = ranking.elements.slice(0, 8).map((e) => `${formatElement(e, url)}  (score ${e.score.toFixed(2)})`);
    const current: GotoStep = { url, bestScore: ranking.bestSectionScore };
    steps.push(current);

    if (ranking.bestSectionScore >= stopScore) {
      stopReason = "found";
      break;
    }
    if (step === maxSteps - 1) break;

    for (const e of ranking.elements) {
      if (!FOLLOWABLE_KINDS.has(e.kind) || UNSAFE_LINK.test(e.text)) continue;
      let key: string;
      if (e.href) {
        if (!/^https?:/i.test(e.href)) continue;
        if (!opts.allowOffsite && siteKey(e.href) !== startSite) continue;
        key = normalize(e.href);
      } else {
        key = `${normalize(url)}#click:${e.kind}:${e.text}`;
      }
      if (visited.has(key)) continue;
      const prev = pool.get(key);
      if (!prev || prev.score < e.score) pool.set(key, { el: e, score: e.score, fromUrl: url });
    }

    // Best candidate overall (lets us back out of a dead-end page). In-page clicks only valid on their page.
    let bestKey: string | null = null;
    let best: Candidate | null = null;
    for (const [k, c] of pool) {
      if (!c.el.href && normalize(c.fromUrl) !== normalize(url)) continue;
      if (!best || c.score > best.score) {
        best = c;
        bestKey = k;
      }
    }
    if (!best || !bestKey || best.score < minLinkScore) {
      stopReason = "no_promising_links";
      break;
    }
    pool.delete(bestKey);
    visited.add(bestKey);
    current.followed = { ref: best.el.ref, text: best.el.text, href: best.el.href, score: best.score };
    try {
      if (best.el.href) await page.goto(best.el.href);
      else await page.click(refSelector(best.el.ref));
      await page.settle();
      visited.add(normalize(page.url()));
    } catch (error) {
      current.error = `follow failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
    }
  }

  passages.sort((a, b) => b.score - a.score);
  const bestScore = passages[0]?.score ?? 0;
  return {
    found: bestScore >= stopScore,
    confidence: bestScore >= stopScore ? "high" : bestScore >= 1.5 ? "medium" : "low",
    passages: passages.slice(0, 5),
    steps,
    finalUrl: page.url(),
    elements: lastElements,
    stopReason,
  };
}
