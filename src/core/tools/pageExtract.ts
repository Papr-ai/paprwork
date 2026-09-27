/**
 * Page extraction for browser tools.
 *
 * Turns a live page into (1) readable text sections grouped under their headings and
 * (2) a numbered list of visible interactive elements. Each element is tagged in the DOM
 * with data-pjid="N" so agents can act on it by ref instead of guessing CSS selectors.
 *
 * Optionally scores sections + elements against a goal with Jev so the agent only reads
 * the parts of the page that matter (see scoreAgainstGoal).
 */

export const PAGE_REF_ATTR = "data-pjid";

export interface RawBlock {
  /** heading level 1-6, or 0 for body text */
  h: number;
  t: string;
}

export interface PageElement {
  ref: number;
  kind: string;
  text: string;
  href?: string;
}

export interface PageSection {
  path: string;
  text: string;
}

export interface RawExtraction {
  blocks: RawBlock[];
  elements: PageElement[];
}

/**
 * Runs inside the page. Must be a self-contained expression (works with Playwright
 * page.evaluate(string) and the embedded Electron adapter's execute).
 */
export const EXTRACT_PAGE_SCRIPT = `(() => {
  const ATTR = ${JSON.stringify(PAGE_REF_ATTR)};
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","SVG","TEMPLATE","IFRAME","CANVAS"]);
  const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,pre,blockquote,figcaption,label,summary,caption,tr,section,article,div,header,footer,main,aside,nav,form,ul,ol,table";
  const visCache = new Map();
  // checkVisibility already accounts for hidden ancestors; display:contents boxes report false,
  // so resolve to the nearest ancestor that actually renders a box.
  const visible = (el) => {
    while (el && el.nodeType === 1 && getComputedStyle(el).display === "contents") el = el.parentElement;
    if (!el || el.nodeType !== 1) return true;
    if (visCache.has(el)) return visCache.get(el);
    let v = true;
    if (SKIP.has(el.tagName)) v = false;
    else if (el.closest("[aria-hidden=true]")) v = false;
    else if (typeof el.checkVisibility === "function") v = el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    else { const s = getComputedStyle(el); v = s.display !== "none" && s.visibility !== "hidden" && !!el.getClientRects().length; }
    visCache.set(el, v);
    return v;
  };
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();

  const blocks = [];
  let lastBlock = null;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = clean(node.nodeValue);
    if (!text) continue;
    const parent = node.parentElement;
    if (!parent || !visible(parent)) continue;
    const block = parent.closest(BLOCK) || parent;
    const hm = block.tagName.match(/^H([1-6])$/);
    const level = hm ? Number(hm[1]) : 0;
    const prev = blocks[blocks.length - 1];
    if (prev && block === lastBlock) prev.t += " " + text;
    else blocks.push({ h: level, t: text });
    lastBlock = block;
    if (blocks.length > 4000) break;
  }

  document.querySelectorAll("[" + ATTR + "]").forEach((el) => el.removeAttribute(ATTR));
  const SEL = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[contenteditable=true]";
  const elements = [];
  const seen = new Set();
  let ref = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = tag === "input" ? (el.getAttribute("type") || "text") : "";
    const kind = role || (tag === "a" ? "link" : tag === "input" ? "input:" + type : tag);
    const text = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || (type === "submit" ? el.value : "")).slice(0, 100);
    const isField = tag === "input" || tag === "select" || tag === "textarea" || role === "checkbox" || role === "switch" || el.isContentEditable;
    if (!text && !isField) continue;
    const href = tag === "a" ? el.href : "";
    const key = kind + "|" + text + "|" + href;
    if (!isField && seen.has(key)) continue;
    seen.add(key);
    el.setAttribute(ATTR, String(ref));
    elements.push({ ref, kind, text, href: href || undefined });
    ref++;
    if (ref >= 400) break;
  }
  return { blocks, elements };
})()`;

const SECTION_CHARS = 700;

/** Group text blocks under their heading path and split into ~700-char sections. */
export function buildSections(blocks: RawBlock[], maxSections = 200): PageSection[] {
  const heads: string[] = [];
  const sections: PageSection[] = [];
  let buf: string[] = [];
  const pathOf = () => heads.filter(Boolean).join(" > ").slice(0, 200);
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    buf = [];
    if (!text) return;
    const path = pathOf();
    const last = sections[sections.length - 1];
    if (last && last.path === path && last.text.length + text.length < SECTION_CHARS) {
      last.text += ` ${text}`;
      return;
    }
    for (let i = 0; i < text.length; i += SECTION_CHARS) {
      sections.push({ path, text: text.slice(i, i + SECTION_CHARS) });
    }
  };
  for (const b of blocks) {
    if (b.h > 0) {
      flush();
      heads.length = b.h - 1;
      for (let i = 0; i < b.h - 1; i++) heads[i] = heads[i] ?? "";
      heads[b.h - 1] = b.t.slice(0, 100);
    } else {
      buf.push(b.t);
      if (buf.join(" ").length >= SECTION_CHARS) flush();
    }
  }
  flush();
  return sections.slice(0, maxSections);
}

function shortHref(href: string | undefined, pageUrl: string): string {
  if (!href) return "";
  try {
    const u = new URL(href);
    const p = new URL(pageUrl);
    if (u.host === p.host) return `${u.pathname}${u.search}${u.hash}`.slice(0, 120);
    return `${u.host}${u.pathname}`.slice(0, 120);
  } catch {
    return href.slice(0, 120);
  }
}

export function formatElement(el: PageElement, pageUrl: string): string {
  const href = shortHref(el.href, pageUrl);
  return `[${el.ref}] ${el.kind} "${el.text}"${href ? ` -> ${href}` : ""}`;
}

export function formatSections(sections: PageSection[], maxChars: number): {
  text: string;
  truncated: boolean;
} {
  let out = "";
  let lastPath: string | null = null;
  for (const s of sections) {
    const piece = (s.path !== lastPath ? `\n## ${s.path || "(top of page)"}\n` : " ") + s.text;
    if (out.length + piece.length > maxChars) {
      return { text: `${out.trim()}\n…(truncated — call with goal to find a specific part)`, truncated: true };
    }
    out += piece;
    lastPath = s.path;
  }
  return { text: out.trim(), truncated: false };
}

export function formatElements(elements: PageElement[], pageUrl: string, maxItems: number): {
  text: string;
  truncated: boolean;
} {
  const lines = elements.slice(0, maxItems).map((e) => formatElement(e, pageUrl));
  const more = elements.length - lines.length;
  return {
    text: lines.join("\n") + (more > 0 ? `\n…(${more} more — call with goal to rank them)` : ""),
    truncated: more > 0,
  };
}

// ---------------------------------------------------------------- goal scoring (Jev)

export const GOAL_LEVELS = ["irrelevant", "related", "likely helps", "definitely what is needed"];

/** Scores items 0..3. Injected so tests can run without the network. */
export type ItemScorer = (
  goal: string,
  kind: "sections" | "elements",
  items: Record<string, string>,
) => Promise<Record<string, number>>;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Default scorer: Jev score questions, 12 items per call, 8 calls in flight. */
export const jevItemScorer: ItemScorer = async (goal, kind, items) => {
  const { evaluateJevWithAuth } = await import("./jevAuth.js");
  const keys = Object.keys(items);
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += 12) batches.push(keys.slice(i, i + 12));
  const noun = kind === "sections" ? "page section" : "page element";
  const results = await mapLimit(batches, 8, async (batch) => {
    const res = await evaluateJevWithAuth({
      state: { goal, [kind]: Object.fromEntries(batch.map((k) => [k, items[k]])) },
      questions: Object.fromEntries(
        batch.map((k) => [
          k,
          {
            type: "score" as const,
            criteria: GOAL_LEVELS,
            instructions:
              kind === "sections"
                ? `Does ${noun} ${k} contain information that serves the goal?`
                : `Would clicking or using ${noun} ${k} move toward the goal?`,
          },
        ]),
      ),
      timeoutMs: 20_000,
    });
    const scores: Record<string, number> = {};
    for (const k of batch) {
      const a = res.answers[k] as { score?: number } | undefined;
      scores[k] = typeof a?.score === "number" ? a.score : 0;
    }
    return scores;
  });
  return Object.assign({}, ...results);
};

export interface GoalRanking {
  sections: Array<PageSection & { score: number }>;
  elements: Array<PageElement & { score: number }>;
  bestSectionScore: number;
}

export async function rankAgainstGoal(
  goal: string,
  sections: PageSection[],
  elements: PageElement[],
  pageUrl: string,
  opts: { topSections?: number; topElements?: number; scorer?: ItemScorer } = {},
): Promise<GoalRanking> {
  const scorer = opts.scorer ?? jevItemScorer;
  const secItems: Record<string, string> = {};
  sections.slice(0, 80).forEach((s, i) => {
    secItems[`S${i}`] = `[${s.path.slice(0, 120)}] ${s.text}`;
  });
  const elItems: Record<string, string> = {};
  elements.slice(0, 150).forEach((e) => {
    const href = shortHref(e.href, pageUrl);
    elItems[`E${e.ref}`] = `${e.kind} "${e.text}"${href ? ` -> ${href}` : ""}`;
  });
  const [secScores, elScores] = await Promise.all([
    Object.keys(secItems).length ? scorer(goal, "sections", secItems) : Promise.resolve({}),
    Object.keys(elItems).length ? scorer(goal, "elements", elItems) : Promise.resolve({}),
  ]);
  const rankedSections = sections
    .slice(0, 80)
    .map((s, i) => ({ ...s, score: (secScores as Record<string, number>)[`S${i}`] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  const rankedElements = Object.entries(elScores as Record<string, number>)
    .map(([k, score]) => ({ ...(byRef.get(Number(k.slice(1))) as PageElement), score }))
    .filter((e) => e.ref !== undefined)
    .sort((a, b) => b.score - a.score);
  return {
    sections: rankedSections.slice(0, opts.topSections ?? 6),
    elements: rankedElements.slice(0, opts.topElements ?? 10),
    bestSectionScore: rankedSections[0]?.score ?? 0,
  };
}

export function formatRanking(r: GoalRanking, pageUrl: string): { content: string; elements: string } {
  const content = r.sections
    .map((s) => `## ${s.path || "(top of page)"}  (score ${s.score.toFixed(2)})\n${s.text}`)
    .join("\n\n");
  const elements = r.elements
    .map((e) => `${formatElement(e, pageUrl)}  (score ${e.score.toFixed(2)})`)
    .join("\n");
  return { content, elements };
}

export function refSelector(ref: number): string {
  return `[${PAGE_REF_ATTR}="${ref}"]`;
}
