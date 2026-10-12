/**
 * Agents page payload (`agent:get-overview`). One read, every section.
 *
 * Token figures use the same columns as the chat context meter: total =
 * new input + cache read + cache write + output, summed over every turn.
 * `cost` is always the API-price value of the turn; `billing` says how much of
 * that was actually billed to an API key versus covered by a subscription.
 */

export interface AgentsOverviewTotals {
  turns: number;
  chats: number;
  cost: number;
  today: number;
  week: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  tokens: number;
  /** Mean of per-turn peak context, over turns that recorded one. */
  avgPeak: number | null;
  avgSteps: number | null;
}

export interface AgentsOverviewBilling {
  apiKey: number;
  subscription: number;
  papr: number;
  /** Turns recorded before billing source was stored. */
  unknown: number;
}

export interface AgentsOverviewChat {
  id: string;
  title: string;
  model: string | null;
  turns: number;
  cost: number;
  tokens: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  peak: number | null;
  steps: number | null;
  last: string;
}

export interface AgentsOverviewModel {
  model: string;
  turns: number;
  cost: number;
  tokens: number;
  peak: number | null;
}

export interface AgentsOverviewAgent {
  id: string;
  turns: number;
  cost: number;
  tokens: number;
}

/** [label, cost] pairs in a fixed order per project kind. */
export interface AgentsOverviewProject {
  id: string;
  name: string;
  tokens: number;
  turns: number;
  chats: number;
  cost: number;
  /** App: build, edit, data, discussion. Repo: edit, build, explore, discussion. */
  split: [number, number, number, number];
}

export interface AgentsOverviewProjects {
  where: { app: number; both: number; repo: number; none: number };
  apps: AgentsOverviewProject[];
  repos: AgentsOverviewProject[];
  /** Share of cost whose app/repo came from recorded columns, not inference. */
  recordedShare: number;
}

export interface AgentsOverviewWorkType {
  label: string;
  cost: number;
  chats: number;
}

export interface AgentsOverview {
  days: number;
  generatedAt: string;
  totals: AgentsOverviewTotals;
  billing: AgentsOverviewBilling;
  daily: Array<{ date: string; cost: number }>;
  chats: AgentsOverviewChat[];
  longTail: { chats: number; cost: number };
  models: AgentsOverviewModel[];
  agents: AgentsOverviewAgent[];
  projects: AgentsOverviewProjects;
  workTypes: AgentsOverviewWorkType[];
  unclassified: { chats: number; cost: number };
  tools: { total: number; top: Array<[string, number]>; bash: Array<[string, number]> };
}
