/**
 * Starter examples for the New app window, built from the user's own library:
 * "Like <app you use most>" plus ideas from the categories they build in most.
 * Pure (no I/O) so it's cheap to run on every open.
 */
export interface CreateAppStarter {
  label: string;
  prompt: string;
}

export interface StarterSourceApp {
  id: string;
  title: string;
  description?: string;
  status?: string;
  openCount?: number;
  lastOpenedAt?: string;
  updatedAt?: string;
}

/** Two ideas per broad category (matches the Jev category list). */
const BANK: Record<string, CreateAppStarter[]> = {
  Sales: [
    { label: "Follow-up reminders", prompt: "Watch my open deals and remind me each morning who I haven't followed up with in a week." },
    { label: "Call prep brief", prompt: "Before each sales call, research the company and the person and give me a one-page brief." },
  ],
  Marketing: [
    { label: "Content repurposer", prompt: "Turn a blog post or transcript into a LinkedIn post, a tweet thread and a newsletter blurb." },
    { label: "Mention tracker", prompt: "Find where my product is mentioned online each day and draft replies for the best threads." },
  ],
  Research: [
    { label: "Topic monitor", prompt: "Every morning, find new articles, papers and threads on topics I choose and summarize what changed." },
    { label: "Competitor watch", prompt: "Watch competitor websites and tell me when pricing, features or messaging change." },
  ],
  Support: [
    { label: "Inbox triage", prompt: "Sort incoming support emails by urgency and draft a reply for each one." },
    { label: "Feedback themes", prompt: "Collect customer feedback from my inbox and notes and group it into themes every week." },
  ],
  Operations: [
    { label: "Meeting follow-ups", prompt: "After each meeting, pull action items from my notes and track them until they're done." },
    { label: "Weekly status report", prompt: "Every Friday, gather what my team shipped and what's blocked into a short status report." },
  ],
  Finance: [
    { label: "Expense tracker", prompt: "Track expenses from receipts I upload, categorize them and show monthly totals." },
    { label: "Runway forecast", prompt: "Forecast my cash runway from monthly revenue and expenses, with base and downside cases." },
  ],
  Engineering: [
    { label: "PR digest", prompt: "Every morning, summarize open pull requests across my repos and flag the ones waiting on me." },
    { label: "Uptime monitor", prompt: "Check my sites every 5 minutes and alert me with details when one goes down." },
  ],
  Analytics: [
    { label: "KPI digest", prompt: "Every Monday, pull my key metrics and send me a short digest of what moved and why." },
    { label: "Funnel report", prompt: "Show my signup-to-paid funnel by week, with where people drop off." },
  ],
  Personal: [
    { label: "Reading list", prompt: "Save articles I paste in, summarize each one, and let me tag and search them." },
    { label: "Habit tracker", prompt: "Track daily habits I choose, with streaks and a weekly review." },
  ],
};

/** Used when the library is empty or not categorized yet. */
const DEFAULT_CATEGORIES = ["Research", "Sales", "Marketing", "Operations", "Personal"];

const UNNAMED = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
const COPY_SUFFIX = /[_\s-]+\d+$/;

function shortLabel(title: string): string {
  const t = title.trim();
  return t.length > 24 ? `${t.slice(0, 23).trimEnd()}…` : t;
}

export function buildCreateAppStarters(
  apps: readonly StarterSourceApp[],
  byKey: Readonly<Record<string, string | null>>,
  max = 5,
): CreateAppStarter[] {
  const live = apps.filter((a) => a.status !== "archived" && a.title && !UNNAMED.test(a.title));

  // 1) "Like <app>" for the two apps they use most (copies collapsed).
  const ranked = [...live].sort(
    (a, b) =>
      (b.openCount ?? 0) - (a.openCount ?? 0) ||
      (b.lastOpenedAt ?? b.updatedAt ?? "").localeCompare(a.lastOpenedAt ?? a.updatedAt ?? ""),
  );
  const seen = new Set<string>();
  const own: CreateAppStarter[] = [];
  for (const a of ranked) {
    const base = a.title.replace(COPY_SUFFIX, "").trim();
    const k = base.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const what = a.description?.trim().replace(/\s+/g, " ").replace(/\.$/, "").slice(0, 140);
    own.push({
      label: `Like ${shortLabel(base)}`,
      prompt: `An app like my "${base}"${what ? ` (${what})` : ""}, but for `,
    });
    if (own.length === 2) break;
  }

  // 2) Ideas from the categories they build in most.
  const counts = new Map<string, number>();
  for (const a of live) {
    const c = byKey[`app:${a.id}`];
    if (c && BANK[c]) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  for (const c of DEFAULT_CATEGORIES) if (!cats.includes(c)) cats.push(c);

  const titles = new Set(live.map((a) => a.title.toLowerCase()));
  const out = [...own];
  for (let round = 0; out.length < max && round < 2; round++) {
    for (const c of cats) {
      const idea = BANK[c]?.[round];
      if (idea && !titles.has(idea.label.toLowerCase())) out.push(idea);
      if (out.length >= max) break;
    }
  }
  return out.slice(0, max);
}
