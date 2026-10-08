/**
 * Goal trackers — every Focus goal should show whether it is actually moving, measured by a job,
 * not just by chat hours. Progress feedback is the moderator that makes goals work (Locke & Latham
 * 2002), and recording progress raises attainment (Harkin et al. 2016, Psychological Bulletin
 * meta-analysis, k=138). Collection is the stage where personal tracking breaks down (Li, Dey &
 * Forlizzi 2010), so Papr automates it.
 *
 * Flow (mixed-initiative, Horvitz 1999 — act when sure, otherwise offer one tap):
 *   1. Jev picks a tracker template for the goal (typed `choice`, cached per goal text).
 *   2. We check the template's data sources against what the user already connected
 *      (Platform Connections keys AND legacy custom keys like X_AUTH_TOKEN).
 *   3. Status: active (job exists) | ready (one tap creates it) | needs_connect | buildable
 *      (no template fits → one tap asks a background agent to build a custom tracker job).
 *   4. Tracker jobs POST /api/workspace/focus/metrics; Focus shows the latest numbers next to the
 *      hours the user spent, so time-in vs outcome-out is visible per goal.
 *
 * Templates are data, not code paths: adding a tracker for a new kind of goal is one entry here
 * (+ optionally a bundled script under resources/goal-trackers/<id>/).
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TrackerSource {
  id: string;
  label: string;
  /** Any one key set connects the source (first is the Platform Connections name). */
  keys: string[][];
}

export interface TrackerTemplate {
  id: string;
  title: string;
  /** Jev criterion: which goals this tracker measures. */
  criterion: string;
  sources: TrackerSource[];
  /** Keys passed to the job when present but not needed to count a source as connected. */
  optionalKeys?: string[];
  metrics: Array<{ key: string; label: string }>;
  /** The one number that proves the goal is paying off — the goal page's headline. Defaults to the first metric. */
  hero?: string;
  /** Bundled script under resources/goal-trackers/<id>/. Absent → an agent builds the job. */
  script?: string;
  requirements?: string[];
  cron: string;
}

export const TRACKER_TEMPLATES: TrackerTemplate[] = [
  {
    id: "social-presence",
    title: "LinkedIn + X posts and engagement",
    criterion:
      "Building an audience or distribution through content: posting on LinkedIn or X/Twitter, commenting, engaging, growing followers or impressions",
    sources: [
      { id: "linkedin", label: "LinkedIn", keys: [["LINKEDIN_LI_AT"]] },
      { id: "x", label: "X", keys: [["TWITTER_AUTH_TOKEN", "TWITTER_CT0"], ["X_AUTH_TOKEN", "X_CT0"]] },
    ],
    optionalKeys: ["LINKEDIN_JSESSIONID"],
    metrics: [
      { key: "posts7", label: "Posts this week" },
      { key: "replies7", label: "Comments & replies" },
      { key: "engagement7", label: "Engagements" },
      { key: "impressions7", label: "Views this week" },
      { key: "followers", label: "Followers" },
    ],
    hero: "impressions7",
    script: "track.py",
    requirements: ["playwright", "linkedin-api"],
    cron: "0 21 * * *",
  },
  {
    id: "revenue",
    title: "Revenue and paying customers",
    criterion: "Revenue, MRR/ARR, paying customers, closed deals, invoices paid",
    sources: [{ id: "stripe", label: "Stripe", keys: [["STRIPE_SECRET_KEY"], ["STRIPE_API_KEY"]] }],
    metrics: [
      { key: "mrr", label: "MRR" },
      { key: "customers", label: "Paying customers" },
      { key: "new7", label: "New this week" },
    ],
    hero: "mrr",
    cron: "0 7 * * *",
  },
  {
    id: "product-usage",
    title: "Product usage and retention",
    criterion: "Active users, signups, activation, retention or engagement inside a product",
    sources: [
      { id: "posthog", label: "PostHog", keys: [["POSTHOG_PERSONAL_API_KEY"]] },
      { id: "amplitude", label: "Amplitude", keys: [["AMPLITUDE_API_KEY", "AMPLITUDE_SECRET_KEY"]] },
    ],
    metrics: [
      { key: "wau", label: "Weekly active users" },
      { key: "signups7", label: "Signups this week" },
    ],
    cron: "0 7 * * *",
  },
  {
    id: "outreach",
    title: "Outreach pipeline",
    criterion: "Outbound outreach or prospecting: messages or connection requests sent, replies, meetings booked",
    sources: [{ id: "linkedin", label: "LinkedIn", keys: [["LINKEDIN_LI_AT"]] }],
    metrics: [
      { key: "sent7", label: "Sent this week" },
      { key: "replies7", label: "Replies" },
      { key: "meetings7", label: "Meetings" },
    ],
    hero: "meetings7",
    cron: "0 18 * * *",
  },
];

const NONE = "NONE";
const ACCEPT = 0.6;

export interface TrackerGoal {
  id: string;
  title: string;
  target?: string;
  scope?: string;
}

/**
 * How a goal that is not "posting" labels itself on the goal page. Everything is optional; without it the page
 * falls back to the template labels and the "N of 7 days showed up" chart. Strings are length-capped, numbers finite.
 */
export interface MetricsDisplay {
  /** Plain words under the payoff number, e.g. "points better than the baseline". */
  label?: string;
  format?: "number" | "usd" | "pts" | "percent" | "hours";
  /** What the time bought, after "9h in chats →", e.g. "v72 is 41% trained · $676 spent". */
  line?: string;
  /** Replaces the default chart. tone: full = accent, part = soft, off = empty. */
  chart?: { caption: string; target?: number; bars: Array<{ label: string; value: number; tone?: "full" | "part" | "off"; title?: string }> };
}

export interface MetricsFile {
  goalId: string;
  template: string;
  updatedAt: string;
  summary: Record<string, number | null>;
  display?: MetricsDisplay;
  /** profile = who the numbers belong to, so the goal page can show a real face/logo, not a label. */
  sources?: Record<string, { ok: boolean; error?: string; profile?: TrackerProfile }>;
  history?: Array<{ date: string } & Record<string, number | string | null>>;
  /** The evidence: posts, deals, people, companies. `at` drives the daily chart; image/domain give it a face. */
  items?: Array<{
    source: string; url?: string; text?: string; at?: string; engagement?: number; impressions?: number | null;
    kind?: "post" | "person" | "company" | "event"; image?: string; domain?: string;
    /** A tile's own number and unit for goals that are not posts, e.g. 2.1 "pts" or 5000 "$". */
    value?: number | null; unit?: string;
  }>;
}

export interface TrackerProfile { handle?: string; name?: string; avatar?: string; url?: string; followers?: number | null }

export interface TrackerState {
  status: "active" | "ready" | "needs_connect" | "buildable";
  template: string | null;
  title: string;
  jobId?: string;
  connected?: string[];
  missing?: string[];
  metrics?: {
    updatedAt: string; summary: Record<string, number | null>; labels: Record<string, string>; sources?: MetricsFile["sources"];
    hero?: string;
    display?: MetricsDisplay;
    /** Last 30 daily snapshots and the newest evidence — what the goal page charts (progress over time). */
    history?: MetricsFile["history"]; items?: MetricsFile["items"];
  };
}

interface TrackersFile {
  version: 1;
  decisions: Record<string, { template: string | null; p: number }>;
  links: Record<string, { template: string | null; jobId: string; createdAt: string }>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
export const goalHash = (g: TrackerGoal) => sha(`${g.title}|${g.target ?? ""}|${g.scope ?? ""}`);
export const findTemplate = (id: string | null | undefined) => TRACKER_TEMPLATES.find((t) => t.id === id);

/** Which key set (if any) connects each source. Pure: `has` says whether a key is configured. */
export function connectedSources(t: TrackerTemplate, has: (key: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of t.sources) {
    const set = s.keys.find((ks) => ks.every(has));
    if (set) out.set(s.id, set);
  }
  return out;
}

export function resolveTrackerState(input: {
  template: TrackerTemplate | undefined;
  link?: { jobId: string };
  jobExists: boolean;
  has: (key: string) => boolean;
  metrics?: MetricsFile | null;
}): TrackerState {
  const t = input.template;
  const labels = Object.fromEntries((t?.metrics ?? []).map((m) => [m.key, m.label]));
  const metrics = input.metrics
    ? {
        updatedAt: input.metrics.updatedAt, summary: input.metrics.summary, labels, sources: input.metrics.sources,
        hero: t?.hero ?? t?.metrics[0]?.key ?? Object.keys(input.metrics.summary ?? {})[0],
        display: input.metrics.display,
        history: (input.metrics.history ?? []).slice(-30), items: (input.metrics.items ?? []).slice(0, 30),
      }
    : undefined;
  if (input.link && input.jobExists) {
    return { status: "active", template: t?.id ?? null, title: t?.title ?? "Custom tracker", jobId: input.link.jobId, metrics };
  }
  if (!t || !t.script) {
    return { status: "buildable", template: t?.id ?? null, title: t?.title ?? "Custom tracker", metrics };
  }
  const conn = connectedSources(t, input.has);
  const connected = t.sources.filter((s) => conn.has(s.id)).map((s) => s.label);
  const missing = t.sources.filter((s) => !conn.has(s.id)).map((s) => s.label);
  return { status: connected.length ? "ready" : "needs_connect", template: t.id, title: t.title, connected, missing, metrics };
}

// ---------- IO ----------

const goalsDir = () => path.join(getPaprWorkspaceDir(), "goals");
const trackersPath = () => path.join(goalsDir(), "trackers.json");
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
export const metricsPath = (goalId: string) => path.join(goalsDir(), "metrics", `${safeId(goalId)}.json`);

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, p);
}

async function readTrackers(): Promise<TrackersFile> {
  const f = await readJson<TrackersFile>(trackersPath());
  return f?.version === 1 ? f : { version: 1, decisions: {}, links: {} };
}

export async function readMetrics(goalId: string): Promise<MetricsFile | null> {
  return readJson<MetricsFile>(metricsPath(goalId));
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Trackers are untrusted input to the goal page: keep only the known shape, capped. */
export function cleanDisplay(raw: unknown): MetricsDisplay | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: MetricsDisplay = {};
  const label = str(r.label, 60);
  if (label) out.label = label;
  if (["number", "usd", "pts", "percent", "hours"].includes(r.format as string)) out.format = r.format as MetricsDisplay["format"];
  const line = str(r.line, 120);
  if (line) out.line = line;
  const c = r.chart as Record<string, unknown> | undefined;
  if (c && Array.isArray(c.bars)) {
    const bars = c.bars.slice(0, 60).flatMap((b: Record<string, unknown>) => {
      const value = num(b?.value), label = str(b?.label, 6);
      if (value === undefined || !label) return [];
      const tone = ["full", "part", "off"].includes(b.tone as string) ? (b.tone as "full" | "part" | "off") : undefined;
      return [{ label, value, ...(tone ? { tone } : {}), ...(str(b.title, 80) ? { title: str(b.title, 80) } : {}) }];
    }).slice(0, 14);
    const caption = str(c.caption, 90);
    if (bars.length && caption) out.chart = { caption, ...(num(c.target) !== undefined ? { target: num(c.target) } : {}), bars };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Tracker jobs report here. Keeps 90 days of history (one row per day, last write wins). */
export async function recordMetrics(input: {
  goalId: string;
  template?: string;
  display?: unknown;
  summary: Record<string, unknown>;
  sources?: MetricsFile["sources"];
  items?: MetricsFile["items"];
}): Promise<MetricsFile> {
  if (!input.goalId || typeof input.goalId !== "string") throw new Error("goalId is required");
  const summary: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(input.summary ?? {})) {
    if (/^[a-z][a-z0-9_]{0,31}$/i.test(k)) summary[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  const prev = await readMetrics(input.goalId);
  const date = new Date().toISOString().slice(0, 10);
  const history = (prev?.history ?? []).filter((h) => h.date !== date);
  history.push({ date, ...summary });
  const file: MetricsFile = {
    goalId: input.goalId,
    template: input.template ?? prev?.template ?? "custom",
    updatedAt: new Date().toISOString(),
    summary,
    display: cleanDisplay(input.display),
    sources: input.sources,
    history: history.slice(-90),
    items: (input.items ?? []).slice(0, 30),
  };
  await writeJson(metricsPath(input.goalId), file);
  return file;
}

type ChoiceJev = (
  state: string,
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>,
) => Promise<Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>>;

const defaultJev: ChoiceJev = async (state, questions) => {
  const { evaluateJevWithAuth } = await import("../../core/tools/jevAuth.js");
  return (await evaluateJevWithAuth({ state, questions, timeoutMs: 20_000 })).answers as Awaited<ReturnType<ChoiceJev>>;
};

/** One Jev call for all goals missing a decision. Cached by goal text, so it runs once per edit. */
export async function decideTemplates(goals: TrackerGoal[], jev: ChoiceJev = defaultJev): Promise<Record<string, string | null>> {
  const file = await readTrackers();
  const todo = goals.filter((g) => !(goalHash(g) in file.decisions));
  if (todo.length) {
    const criteria: Record<string, string> = Object.fromEntries(TRACKER_TEMPLATES.map((t) => [t.id, t.criterion]));
    criteria[NONE] = "None of these measures it";
    const state = todo
      .map((g, i) => `#${i + 1} Goal: ${g.title}${g.target ? `. Done when: ${g.target}` : ""}${g.scope ? `. Counts: ${g.scope}` : ""}`)
      .join("\n");
    const questions = Object.fromEntries(
      todo.map((_, i) => [`g${i + 1}`, { type: "choice" as const, instructions: `Which tracker best measures progress on goal #${i + 1}?`, criteria }]),
    );
    const answers = await jev(state, questions);
    todo.forEach((g, i) => {
      const a = answers[`g${i + 1}`];
      const p = a?.confidence ?? 0;
      const template = a?.choice && a.choice !== NONE && p >= ACCEPT && findTemplate(a.choice) ? a.choice : null;
      file.decisions[goalHash(g)] = { template, p: Math.round(p * 100) / 100 };
    });
    await writeJson(trackersPath(), file);
  }
  return Object.fromEntries(goals.map((g) => [g.id, file.decisions[goalHash(g)]?.template ?? null]));
}

let deciding: Promise<unknown> | null = null;

/** Tracker state for each goal, from cache only (never blocks on Jev); kicks off decisions in the background. */
export async function trackerStates(goals: TrackerGoal[]): Promise<Record<string, TrackerState>> {
  const [file, keys, jobIds] = await Promise.all([readTrackers(), configuredKeys(), existingJobIds()]);
  const out: Record<string, TrackerState> = {};
  let undecided = false;
  for (const g of goals) {
    const link = file.links[g.id];
    const decision = file.decisions[goalHash(g)];
    if (!decision && !link) undecided = true;
    const template = findTemplate(link?.template ?? decision?.template);
    out[g.id] = resolveTrackerState({
      template,
      link,
      jobExists: Boolean(link && jobIds.has(link.jobId)),
      has: (k) => keys.has(k),
      metrics: await readMetrics(g.id),
    });
  }
  if (undecided && !deciding && !process.env.VITEST) {
    deciding = decideTemplates(goals)
      .catch((err) => console.warn("[focus] tracker decision failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        deciding = null;
      });
  }
  return out;
}

const ALL_KEYS = [...new Set(TRACKER_TEMPLATES.flatMap((t) => t.sources.flatMap((s) => s.keys.flat())))];

async function configuredKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { getApiKey } = await import("../utils/keyResolver.js");
    await Promise.all(ALL_KEYS.map(async (k) => ((await getApiKey(k).catch(() => undefined)) ? out.add(k) : null)));
  } catch {
    /* no keychain in this context */
  }
  return out;
}

async function existingJobIds(): Promise<Set<string>> {
  try {
    const { getJobsService } = await import("./JobsService.js");
    const svc = getJobsService();
    await svc.initialize();
    return new Set((await svc.listJobs()).map((j) => j.id));
  } catch {
    return new Set();
  }
}

/**
 * The goal page is visual-first (a chart of progress over time, real faces and logos, the evidence as
 * tiles). It can only draw what trackers send, so every tracker is asked for the same shape. Full design
 * rationale + citations: src/resources/skills/goal-page-design.md (skill preloaded-goal-page-design).
 */
export const GOAL_PAGE_CONTRACT = [
  `   Also send what the goal page draws (read_skill preloaded-goal-page-design):`,
  `   - Put the ONE number that proves the goal is paying off first in summary (e.g. impressions7, revenue, signed). Summary is snapshotted daily into history, which becomes the progress chart.`,
  `   - "items": the evidence, newest first, max 30: {"source", "url", "text" (<=140 chars), "at" (ISO time — drives the daily chart), "engagement"?, "impressions"?, "kind"?: "post"|"person"|"company"|"event", "image"? (https avatar/thumbnail), "domain"? (company site, e.g. "stripe.com" — the page shows its logo)}.`,
  `   - sources.<name>.profile: {"handle", "name", "avatar" (https profile picture URL from the platform), "url", "followers"} so the page shows the real person or brand, not a label.`,
  `   - Goals that are not posting (training, fundraising, revenue, hiring): also send "display": {"label": plain words under the number (e.g. "points better than baseline"), "format": "number"|"usd"|"pts"|"percent"|"hours", "line": what the time bought (<=120 chars), "chart": {"caption": the takeaway, "target"?: number, "bars": [{"label": <=6 chars, "value": number, "tone"?: "full"|"part"|"off", "title"?: "tooltip"}] (max 14 bars, the series that shows progress)}}, and give items "value" + "unit" (e.g. 2.1 "pts") so a tile names its own number.`,
  `   - Real images only: platform profile pictures, company domains for logos (look the domain up with web search if you only have a name). Never generate or guess images.`,
];

/** Prompt for the background agent that builds a tracker when no template script fits. */
export function builderPrompt(goal: TrackerGoal, template: TrackerTemplate | undefined, gateway: string): string {
  const metrics = template?.metrics.map((m) => `${m.key} (${m.label})`).join(", ");
  return [
    `Build a recurring tracker job that measures progress on this Focus goal, then run it once.`,
    ``,
    `Goal id: ${goal.id}`,
    `Goal: ${goal.title}${goal.target ? `\nDone when: ${goal.target}` : ""}${goal.scope ? `\nCounts as: ${goal.scope}` : ""}`,
    template ? `Suggested tracker: ${template.title}. Metrics: ${metrics}.` : `No built-in tracker fits; pick 2-5 numbers that show this goal moving.`,
    ``,
    `Rules:`,
    `1. First call list_keys, connect_platform status and list_jobs. Reuse an existing job or connected source before adding anything new. Never ask for a key the user already has under another name.`,
    `2. Prefer a deterministic python job (no LLM per run). Schedule it daily. Respect platform rate limits.`,
    `3. The job must report with one HTTP call: POST ${gateway}/api/workspace/focus/metrics`,
    `   body {"goalId": "${goal.id}", "template": "${template?.id ?? "custom"}", "summary": {<metric>: <number>}, "sources": {<source>: {"ok": true|false, "error"?: "..."}}}`,
    `   Numbers only in summary; use null when a source is unavailable — never invent values.`,
    ...GOAL_PAGE_CONTRACT,
    `4. Create it with create_job (appIds: ["bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"], folder "focus-trackers"), run it once, read its logs, and fix it until the POST succeeds.`,
    `5. Finish with POST ${gateway}/api/workspace/focus/tracker/link body {"goalId": "${goal.id}", "jobId": "<the job id>", "template": "${template?.id ?? "custom"}"}.`,
    `If a needed source is not connected, stop and say exactly which one (connect_platform request_connect) instead of guessing.`,
  ].join("\n");
}

export async function linkTracker(goalId: string, jobId: string, template: string | null): Promise<void> {
  const file = await readTrackers();
  file.links[goalId] = { template, jobId, createdAt: new Date().toISOString() };
  await writeJson(trackersPath(), file);
}

/**
 * The user just tapped "Track this", so the first run is explicitly requested work: admit it through
 * the interactive lane like run_job / startJobRunForApi. Started as plain background work it waited
 * out the 120s maintenance grace whenever a chat was streaming, so the tracker card sat on
 * "Waiting for execution capacity" with no numbers. (Active work is still never preempted.)
 */
function startNow(run: () => Promise<unknown>, what: string): void {
  void import("./gatewayBackgroundBudget.js")
    .then(({ gatewayBackgroundBudget }) => gatewayBackgroundBudget.runInteractive(run))
    .catch((err) => console.warn(`[focus] ${what} failed:`, err instanceof Error ? err.message : err));
}

/** One tap from Focus: create (and start) the tracker job for a goal. */
export async function createTracker(goal: TrackerGoal): Promise<{ jobId: string; kind: "script" | "builder" }> {
  const file = await readTrackers();
  const existing = file.links[goal.id];
  const { getJobsService } = await import("./JobsService.js");
  const svc = getJobsService();
  await svc.initialize();
  if (existing && (await svc.getJob(existing.jobId))) return { jobId: existing.jobId, kind: "script" };

  const decision = file.decisions[goalHash(goal)] ?? { template: (await decideTemplates([goal]))[goal.id] ?? null };
  const template = findTemplate(decision.template);
  const { DEFAULT_HOME_APP_ID } = await import("./defaultHomeBundle.js");
  const gateway = `http://127.0.0.1:${Number(process.env.GATEWAY_PORT ?? 18789)}`;

  if (template?.script) {
    const keys = await configuredKeys();
    const conn = connectedSources(template, (k) => keys.has(k));
    if (!conn.size) throw new Error(`Connect ${template.sources.map((s) => s.label).join(" or ")} first`);
    const optional = (template.optionalKeys ?? []).filter((k) => keys.has(k));
    const requiredKeys = [...new Set([...[...conn.values()].flat(), ...optional])];
    const job = await svc.createJob({
      name: `Focus tracker · ${template.title}`,
      type: "python",
      appIds: [DEFAULT_HOME_APP_ID],
      folder: "focus-trackers",
      command: `python3 track.py --goal ${JSON.stringify(goal.id)}`,
      requiredKeys,
      requirements: template.requirements,
      // track.py reports each source separately; no LinkedIn browser must not cost the X numbers.
      platformCdp: "best-effort",
      schedule: { enabled: true, cron: template.cron },
      retries: { maxAttempts: 2, backoffMs: 30_000 },
    });
    const jobDir = await svc.getJobPath(job.id);
    const { resolveBundledResourcesDir } = await import("../../core/utils/bundledResourcesPath.js");
    const src = await resolveBundledResourcesDir(__dirname, `resources/goal-trackers/${template.id}`);
    if (!jobDir || !src) throw new Error("Tracker script bundle not found");
    for (const f of await fs.readdir(src)) await fs.copyFile(path.join(src, f), path.join(jobDir, f));
    await linkTracker(goal.id, job.id, template.id);
    startNow(() => svc.runJob(job.id), "first tracker run");
    return { jobId: job.id, kind: "script" };
  }

  // No script for this kind of goal: a background agent designs and creates the tracker job.
  const builder = await svc.createJob({
    name: `Focus tracker builder · ${goal.title.slice(0, 60)}`,
    type: "agent",
    appIds: [DEFAULT_HOME_APP_ID],
    folder: "focus-trackers",
    command: builderPrompt(goal, template, gateway),
    maxTurns: 40,
  });
  await linkTracker(goal.id, builder.id, template?.id ?? null);
  startNow(() => svc.runJob(builder.id), "tracker builder");
  return { jobId: builder.id, kind: "builder" };
}
