/**
 * Pure fold from overview rows to the Agents page payload. No I/O, so the
 * whole page's math is unit-testable against fixture rows.
 */

import type {
  AgentsOverview,
  AgentsOverviewChat,
  AgentsOverviewProject,
} from "../../../core/types/agentsOverview.js";
import { inferTurnTargets } from "../storage/turnAttribution.js";
import type { OverviewChatMeta, OverviewRow } from "./overviewRows.js";

export const BASH_INTENTS: Array<[string, RegExp]> = [
  ["sqlite", /\bsqlite3\b/],
  ["curl", /\bcurl\s/],
  ["git", /(^|[\s;&|(])(git|gh)\s/],
  ["Build / test", /\b(npm|npx|pnpm|yarn|tsc|vitest|esbuild|jest|pytest)\b/],
  ["Scripts", /\b(python3?|node|tsx|deno|bun)\s/],
  ["Search", /(^|[\s;&|(])(rg|grep|find|fd|ag)\s/],
  ["Read files", /(^|[\s;&|(])(sed -n|cat|head|tail|wc|less)\s/],
  ["List / navigate", /^\s*(ls|cd|pwd|tree)\b/],
];

export function bashIntent(command: string): string {
  const c = command.toLowerCase();
  for (const [label, re] of BASH_INTENTS) if (re.test(c)) return label;
  return "Other";
}

const EDIT_TOOLS = new Set(["edit_file", "write_file", "edit_app_file_lines", "edit_app_file"]);
const BUILD_TOOLS = new Set(["create_app"]);
const DATA_TOOLS = new Set(["create_job", "run_job", "update_job", "create_database", "attach_database"]);
const TEST_RE = /\b(npm|npx|pnpm|tsc|vitest|jest|pytest|esbuild)\b/;

type Split = [number, number, number, number];

interface ProjectAcc {
  name: string;
  tokens: number;
  turns: number;
  chats: Set<string>;
  split: Split;
}

function acc(map: Map<string, ProjectAcc>, id: string, name: string): ProjectAcc {
  let p = map.get(id);
  if (!p) {
    p = { name, tokens: 0, turns: 0, chats: new Set(), split: [0, 0, 0, 0] };
    map.set(id, p);
  }
  return p;
}

function finishProjects(map: Map<string, ProjectAcc>, limit: number): AgentsOverviewProject[] {
  return [...map.entries()]
    .map(([id, p]) => ({
      id,
      name: p.name,
      tokens: p.tokens,
      turns: p.turns,
      chats: p.chats.size,
      cost: p.split.reduce((a, n) => a + n, 0),
      split: p.split,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}

export interface AggregateInput {
  rows: OverviewRow[];
  chats: OverviewChatMeta[];
  days: number;
  now: Date;
  appTitles: Map<string, string>;
  /** chatId → Jev work-type label, for chats already classified. */
  workTypes: Map<string, string>;
  paprRoot?: string;
  chatLimit?: number;
}

export function aggregateOverview(input: AggregateInput): AgentsOverview {
  const { rows, now, appTitles } = input;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 864e5).toISOString();
  const titles = new Map(input.chats.map((c) => [c.id, c.title]));

  const totals = { turns: 0, cost: 0, today: 0, week: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let peakSum = 0, peakN = 0, stepSum = 0, stepN = 0;
  const billing = { apiKey: 0, subscription: 0, papr: 0, unknown: 0 };
  const daily = new Map<string, number>();
  const chats = new Map<string, AgentsOverviewChat>();
  const models = new Map<string, { turns: number; cost: number; tokens: number; peak: number | null }>();
  const agents = new Map<string, { turns: number; cost: number; tokens: number }>();
  const toolCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();
  const apps = new Map<string, ProjectAcc>();
  const repos = new Map<string, ProjectAcc>();
  const where = { app: 0, both: 0, repo: 0, none: 0 };
  const sticky = new Map<string, { appId: string | null; repo: string | null }>();
  let recordedCost = 0;

  for (const r of rows) {
    const tokens = r.fresh + r.cache_read + r.cache_write + r.output;
    totals.turns += 1;
    totals.cost += r.cost;
    totals.fresh += r.fresh;
    totals.cacheRead += r.cache_read;
    totals.cacheWrite += r.cache_write;
    totals.output += r.output;
    if (r.timestamp >= todayStart) totals.today += r.cost;
    if (r.timestamp >= weekStart) totals.week += r.cost;
    if (r.peak) { peakSum += r.peak; peakN += 1; }
    if (r.steps) { stepSum += r.steps; stepN += 1; }

    if (r.billing === "api_key") billing.apiKey += r.cost;
    else if (r.billing === "subscription") billing.subscription += r.cost;
    else if (r.billing === "papr") billing.papr += r.cost;
    else billing.unknown += r.cost;

    const day = r.timestamp.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + r.cost);

    const chat = chats.get(r.chat_id) ?? {
      id: r.chat_id, title: titles.get(r.chat_id) ?? "", model: null, turns: 0, cost: 0,
      tokens: 0, cacheRead: 0, cacheWrite: 0, output: 0, peak: null, steps: null, last: r.timestamp,
    };
    chat.turns += 1;
    chat.cost += r.cost;
    chat.tokens += tokens;
    chat.cacheRead += r.cache_read;
    chat.cacheWrite += r.cache_write;
    chat.output += r.output;
    if (r.peak && (chat.peak ?? 0) < r.peak) chat.peak = r.peak;
    if (r.steps) chat.steps = (chat.steps ?? 0) + r.steps;
    chat.last = r.timestamp;
    chat.model = r.model ?? chat.model;
    chats.set(r.chat_id, chat);

    if (r.model) {
      const m = models.get(r.model) ?? { turns: 0, cost: 0, tokens: 0, peak: null };
      m.turns += 1; m.cost += r.cost; m.tokens += tokens;
      if (r.peak && (m.peak ?? 0) < r.peak) m.peak = r.peak;
      models.set(r.model, m);
    }
    const a = agents.get(r.agent_id) ?? { turns: 0, cost: 0, tokens: 0 };
    a.turns += 1; a.cost += r.cost; a.tokens += tokens;
    agents.set(r.agent_id, a);

    const names = (r.tools ?? "").split(",").filter(Boolean);
    for (const n of names) toolCounts.set(n, (toolCounts.get(n) ?? 0) + 1);
    const bashCommands = (r.bash ?? "").split("\u001e").filter(Boolean);
    for (const cmd of bashCommands) {
      const k = bashIntent(cmd);
      bashCounts.set(k, (bashCounts.get(k) ?? 0) + 1);
    }

    // Project attribution: recorded columns first, then inference from tool args.
    const recorded = Boolean(r.app_id || r.repo);
    const inferred = recorded
      ? { appId: r.app_id, repo: r.repo }
      : inferTurnTargets((r.targets ?? "").split("\n"), { paprRoot: input.paprRoot });
    let { appId, repo } = inferred;
    if (appId && !appTitles.has(appId)) appId = null;
    let discussion = false;
    if (appId || repo) sticky.set(r.chat_id, { appId, repo });
    else if (sticky.has(r.chat_id)) {
      ({ appId, repo } = sticky.get(r.chat_id)!);
      discussion = true;
    }
    if (recorded) recordedCost += r.cost;
    where[appId && repo ? "both" : appId ? "app" : repo ? "repo" : "none"] += r.cost;

    const hasEdit = names.some((n) => EDIT_TOOLS.has(n));
    const hasTest = TEST_RE.test(r.bash ?? "");
    if (appId) {
      const p = acc(apps, appId, appTitles.get(appId) ?? appId);
      const slot = discussion ? 3 : names.some((n) => BUILD_TOOLS.has(n)) ? 0
        : names.some((n) => DATA_TOOLS.has(n)) && !hasEdit ? 2 : 1;
      p.split[slot] += r.cost; p.tokens += tokens; p.turns += 1; p.chats.add(r.chat_id);
    }
    if (repo) {
      const p = acc(repos, repo, repo);
      const slot = discussion ? 3 : hasTest ? 1 : hasEdit ? 0 : 2;
      p.split[slot] += r.cost; p.tokens += tokens; p.turns += 1; p.chats.add(r.chat_id);
    }
  }

  const chatList = [...chats.values()]
    .map((c) => ({ ...c, title: c.title || "Untitled chat", steps: c.steps ? Math.round((c.steps / c.turns) * 10) / 10 : null }))
    .sort((a, b) => b.cost - a.cost);
  const limit = input.chatLimit ?? 30;
  const shown = chatList.slice(0, limit);
  const tail = chatList.slice(limit);

  const work = new Map<string, { cost: number; chats: number }>();
  let unclassified = { chats: 0, cost: 0 };
  for (const c of chatList) {
    const label = input.workTypes.get(c.id);
    if (!label) { unclassified = { chats: unclassified.chats + 1, cost: unclassified.cost + c.cost }; continue; }
    const w = work.get(label) ?? { cost: 0, chats: 0 };
    w.cost += c.cost; w.chats += 1;
    work.set(label, w);
  }

  const tokens = totals.fresh + totals.cacheRead + totals.cacheWrite + totals.output;
  const sortDesc = <T>(m: Map<string, T>, by: (v: T) => number) =>
    [...m.entries()].sort((a, b) => by(b[1]) - by(a[1]));

  return {
    days: input.days,
    generatedAt: now.toISOString(),
    totals: {
      ...totals,
      chats: chats.size,
      tokens,
      avgPeak: peakN ? Math.round(peakSum / peakN) : null,
      avgSteps: stepN ? Math.round((stepSum / stepN) * 10) / 10 : null,
    },
    billing,
    daily: [...daily.entries()].map(([date, cost]) => ({ date, cost })),
    chats: shown,
    longTail: { chats: tail.length, cost: tail.reduce((s, c) => s + c.cost, 0) },
    models: sortDesc(models, (m) => m.cost).map(([model, m]) => ({ model, ...m })),
    agents: sortDesc(agents, (a) => a.cost).map(([id, a]) => ({ id, ...a })),
    projects: {
      where,
      apps: finishProjects(apps, 10),
      repos: finishProjects(repos, 8),
      recordedShare: totals.cost > 0 ? recordedCost / totals.cost : 0,
    },
    workTypes: sortDesc(work, (w) => w.cost).map(([label, w]) => ({ label, ...w })),
    unclassified,
    tools: {
      total: [...toolCounts.values()].reduce((a, n) => a + n, 0),
      top: sortDesc(toolCounts, (n) => n).slice(0, 8),
      bash: sortDesc(bashCounts, (n) => n),
    },
  };
}
