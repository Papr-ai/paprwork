/**
 * demoMemory.ts — fixture knowledge graph for the web demo build.
 *
 * Powers the Memory (Wiki Library) view when VITE_DEMO_MODE === "1".
 * A compact-but-rich GTM workspace: 2 projects, 4 people, 3 companies,
 * a goal and an insight — plus context .md files. Shapes mirror
 * types/wiki.ts exactly so the real WikiLibrary renders unchanged.
 */
import type {
  WikiHomeData,
  WikiNode,
  WikiEntityData,
  WikiRail,
  WikiRelatedMemory,
} from "../../types/wiki";

type NodeSeed = Omit<WikiNode, "description" | "props"> & {
  description: string;
  props: Record<string, string | number | boolean>;
};

const N = (n: NodeSeed): WikiNode => n;

/* ---------------- entities ---------------- */

const PROJECTS: WikiNode[] = [
  N({
    id: "q1-enterprise-expansion",
    type: "project",
    label: "Q1 Enterprise Expansion",
    description:
      "Land 6 enterprise logos and $1.2M new ARR by end of Q1 by focusing the team on the 24 highest-intent accounts.",
    props: {
      status: "On track",
      owner: "You",
      quarter: "Q1 2025",
      target: "$1.2M ARR",
      progress: "58%",
    },
    markdownBody:
      "## Overview\n" +
      "Concentrate rep energy on the 24 accounts showing real buying signals instead of spraying the whole list. " +
      "Northwind and Acme are the two furthest along and together represent ~$420K of the target.\n\n" +
      "## Current focus\n" +
      "- **Northwind Traders** — proposal sent, champion (Dana) re-opened pricing twice this week.\n" +
      "- **Acme Logistics** — in procurement; Marcus (CFO) wants an ROI one-pager.\n" +
      "- **Klein Supply** — just raised a Series A, budget is opening up.\n\n" +
      "## Risks\n" +
      "- Acme legal review could slip the close past Mar 31.\n" +
      "- One rep is carrying 40% of the pipeline — single point of failure.",
    relationships: [
      { type: "targets", target: "Northwind Traders" },
      { type: "targets", target: "Acme Logistics" },
      { type: "targets", target: "Klein Supply Co." },
      { type: "led_by", target: "Priya Nair" },
      { type: "supports", target: "Close $1.2M new ARR in Q1" },
    ],
    evidence: [
      {
        date: "2025-01-22",
        source: "Chat · Pipeline review",
        summary: "Flagged Northwind as most likely Q1 close after pricing re-open.",
      },
      {
        date: "2025-01-18",
        source: "App · Pipeline Signals",
        summary: "Klein Supply Series A detected — moved from cold to discovery.",
      },
    ],
  }),
  N({
    id: "papr-work-ga-launch",
    type: "project",
    label: "Papr Work GA Launch",
    description:
      "Ship Papr Work to general availability in March: desktop app, mini-apps marketplace, and memory.",
    props: {
      status: "In progress",
      owner: "You",
      launchDate: "Mar 18, 2025",
      progress: "72%",
    },
    markdownBody:
      "## Overview\n" +
      "GA milestone for the desktop app. Marketing site, pricing, and the community apps tab are the long poles.\n\n" +
      "## Workstreams\n" +
      "- **Product** — memory + mini-apps stable in the demo build.\n" +
      "- **GTM** — landing page redesign (V3) in review.\n" +
      "- **Pricing** — Pro / Team tiers finalized.",
    relationships: [
      { type: "led_by", target: "Priya Nair" },
      { type: "supports", target: "Close $1.2M new ARR in Q1" },
    ],
    evidence: [
      {
        date: "2025-01-20",
        source: "Doc · Launch plan",
        summary: "Locked Mar 18 GA date; landing V3 to ship one week prior.",
      },
    ],
  }),
];

const COMPANIES: WikiNode[] = [
  N({
    id: "northwind-traders",
    type: "company",
    label: "Northwind Traders",
    description:
      "Mid-market logistics distributor (1,200 employees). Evaluating Papr Work for their revenue team after a warm intro from Dana.",
    props: {
      industry: "Logistics",
      employees: "1,200",
      stage: "Proposal sent",
      potential: "$180K ARR",
      region: "Midwest US",
    },
    markdownBody:
      "## Why they matter\n" +
      "Furthest-along enterprise deal in Q1. Champion is strong; risk is a quiet economic buyer.\n\n" +
      "## Latest\n" +
      "- Dana re-opened the pricing page twice this week.\n" +
      "- Asked for a security questionnaire — sent Jan 21.",
    relationships: [
      { type: "champion", target: "Dana Whitfield" },
      { type: "part_of", target: "Q1 Enterprise Expansion" },
    ],
    evidence: [
      {
        date: "2025-01-23",
        source: "App · Account Research",
        summary: "Two pricing-page views by Dana in 48h — high intent.",
      },
    ],
  }),
  N({
    id: "acme-logistics",
    type: "company",
    label: "Acme Logistics",
    description:
      "National freight carrier (3,400 employees). In procurement; CFO wants a hard ROI case before signing.",
    props: {
      industry: "Freight",
      employees: "3,400",
      stage: "Negotiation",
      potential: "$240K ARR",
      region: "US National",
    },
    relationships: [
      { type: "economic_buyer", target: "Marcus Lee" },
      { type: "part_of", target: "Q1 Enterprise Expansion" },
    ],
    evidence: [
      {
        date: "2025-01-19",
        source: "Chat · Deal desk",
        summary: "Marcus requested ROI one-pager framed on hours saved per rep.",
      },
    ],
  }),
  N({
    id: "klein-supply",
    type: "company",
    label: "Klein Supply Co.",
    description:
      "Industrial supply company (600 employees). Just raised a Series A — budget opening up for tooling.",
    props: {
      industry: "Industrial supply",
      employees: "600",
      stage: "Discovery",
      potential: "$90K ARR",
      signal: "Raised Series A",
    },
    relationships: [{ type: "part_of", target: "Q1 Enterprise Expansion" }],
  }),
];

const PEOPLE: WikiNode[] = [
  N({
    id: "dana-whitfield",
    type: "person",
    label: "Dana Whitfield",
    description:
      "Your champion at Northwind. Former ops lead who values time saved over feature lists. Highly engaged this week.",
    props: {
      role: "VP Operations",
      company: "Northwind Traders",
      relationship: "Champion",
      email: "dana@northwind.example",
    },
    markdownBody:
      "## How to work with Dana\n" +
      "- Leads with outcomes, not features. Frame everything as hours saved.\n" +
      "- Prefers a short Loom over a long deck.\n" +
      "- Needs help selling internally to the CFO.",
    relationships: [
      { type: "works_at", target: "Northwind Traders" },
      { type: "champions", target: "Q1 Enterprise Expansion" },
    ],
    evidence: [
      {
        date: "2025-01-23",
        source: "App · Account Research",
        summary: "Re-opened pricing twice; replied to last email in 20 min.",
      },
    ],
  }),
  N({
    id: "marcus-lee",
    type: "person",
    label: "Marcus Lee",
    description:
      "CFO and economic buyer at Acme Logistics. Numbers-first; will not move without a clear ROI model.",
    props: {
      role: "CFO",
      company: "Acme Logistics",
      relationship: "Economic buyer",
    },
    relationships: [{ type: "works_at", target: "Acme Logistics" }],
  }),
  N({
    id: "priya-nair",
    type: "person",
    label: "Priya Nair",
    description:
      "Head of Growth on your team. Runs the Q1 expansion and the GA launch. Your go-to for pipeline strategy.",
    props: {
      role: "Head of Growth",
      company: "Your team",
      relationship: "Teammate",
    },
    relationships: [
      { type: "leads", target: "Q1 Enterprise Expansion" },
      { type: "leads", target: "Papr Work GA Launch" },
    ],
  }),
  N({
    id: "sam-ortiz",
    type: "person",
    label: "Sam Ortiz",
    description:
      "Account Executive carrying the Northwind and Acme deals. Strong closer, currently over-loaded.",
    props: {
      role: "Account Executive",
      company: "Your team",
      relationship: "Teammate",
    },
    relationships: [{ type: "owns_deal", target: "Northwind Traders" }],
  }),
];

const GOALS_INSIGHTS: WikiNode[] = [
  N({
    id: "q1-arr",
    type: "goal",
    label: "Close $1.2M new ARR in Q1",
    description:
      "Primary revenue goal for the quarter. Currently 58% to target with 6 weeks left.",
    props: { status: "58% to goal", deadline: "Mar 31, 2025", progress: "58%" },
    relationships: [
      { type: "advanced_by", target: "Q1 Enterprise Expansion" },
      { type: "advanced_by", target: "Papr Work GA Launch" },
    ],
  }),
  N({
    id: "roi-framing",
    type: "insight",
    label: "Enterprise buyers respond to ROI framing",
    description:
      "Across the last 8 enterprise deals, framing on hours saved per rep per week closed ~2x faster than feature-led pitches.",
    props: { confidence: "High", source: "Win/loss analysis" },
  }),
];

const ALL: WikiNode[] = [...PROJECTS, ...COMPANIES, ...PEOPLE, ...GOALS_INSIGHTS];
const BY_LABEL = new Map(ALL.map((n) => [n.label.toLowerCase(), n]));
const BY_ID = new Map(ALL.map((n) => [`${n.type}:${n.id}`, n]));

/* ---------------- context .md files ---------------- */

const CONTEXT_FILES = [
  {
    name: "IDENTITY.md",
    content:
      "# Who we are\n\n" +
      "We sell **Papr Work** — a desktop workspace where GTM teams build small, " +
      "agent-powered apps on top of their own memory.\n\n" +
      "- **ICP:** Series A–C B2B revenue teams (20–200 reps)\n" +
      "- **Wedge:** replace 5 disconnected tools with one memory-backed workspace\n" +
      "- **Voice:** direct, outcome-led, no hype\n",
  },
  {
    name: "ICP.md",
    content:
      "# Ideal Customer Profile\n\n" +
      "**Fit signals**\n" +
      "- 20–200 quota-carrying reps\n" +
      "- Uses a CRM but reps still live in spreadsheets\n" +
      "- Recently raised (budget available)\n\n" +
      "**Disqualifiers**\n" +
      "- < 10 reps\n" +
      "- Hard requirement for on-prem only\n",
  },
  {
    name: "PLAYBOOK.md",
    content:
      "# Enterprise Playbook\n\n" +
      "1. Lead with hours saved per rep per week (see insight: ROI framing).\n" +
      "2. Find the champion, then arm them to sell the CFO.\n" +
      "3. Send a security questionnaire proactively for 1,000+ employee accounts.\n" +
      "4. Always leave the call with a mutual action plan.\n",
  },
].map((f) => ({
  name: f.name,
  content: f.content,
  size: new TextEncoder().encode(f.content).length,
  truncated: false,
  rawLength: f.content.length,
}));

/* ---------------- related memories ---------------- */

const MEMORIES: WikiRelatedMemory[] = [
  {
    id: "m1",
    content:
      "Dana said the ops team wastes ~6 hours a week reconciling account notes across tools.",
    category: "Discovery",
    createdAt: "2025-01-16",
    relevanceScore: 0.94,
  },
  {
    id: "m2",
    content:
      "Marcus will only sign once he sees payback inside two quarters.",
    category: "Deal note",
    createdAt: "2025-01-19",
    relevanceScore: 0.88,
  },
  {
    id: "m3",
    content:
      "Klein Supply Series A led by Bessemer — new VP Ops starts in February.",
    category: "Signal",
    createdAt: "2025-01-18",
    relevanceScore: 0.81,
  },
];

/* ---------------- home + entity builders ---------------- */

const rail = (title: string, items: WikiNode[], reason?: string): WikiRail => ({
  title,
  reason,
  items,
});

export function wikiHome(): WikiHomeData {
  return {
    featured: PROJECTS[0],
    rails: [
      rail("Continue where you left off", [PROJECTS[0], COMPANIES[0], PEOPLE[0]], "Recently active"),
      rail("Projects", PROJECTS),
      rail("People", PEOPLE),
      rail("Companies", COMPANIES),
      rail("Goals & insights", GOALS_INSIGHTS),
    ],
    typeCounts: { project: 2, person: 4, company: 3, goal: 1, insight: 1 },
    configured: true,
    relatedMemories: MEMORIES,
  };
}

function resolve(target: string): WikiNode | undefined {
  return BY_LABEL.get(target.toLowerCase());
}

export function wikiEntity(input: { type?: string; id?: string; label?: string }): WikiEntityData {
  const node =
    (input.type && input.id && BY_ID.get(`${input.type}:${input.id}`)) ||
    (input.label && resolve(input.label)) ||
    null;
  if (!node) return { node: null, edges: [], rails: [], error: "Entity not found" };

  const connected: WikiNode[] = [];
  const seen = new Set<string>();
  for (const rel of node.relationships ?? []) {
    const t = resolve(rel.target);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      connected.push(t);
    }
  }
  const rails = connected.length ? [rail("Connected", connected, "from knowledge graph")] : [];
  const edges = connected.map((t) => ({ from: node.id, to: t.id, type: "related" }));
  return { node, edges, rails, relatedMemories: MEMORIES.slice(0, 2) };
}

export function wikiSearch(query: string): { results: WikiNode[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { results: [] };
  return {
    results: ALL.filter(
      (n) => n.label.toLowerCase().includes(q) || n.description.toLowerCase().includes(q),
    ).slice(0, 8),
  };
}

export function contextPreview(): { workspaceFiles: typeof CONTEXT_FILES; onboardingPending: boolean } {
  return { workspaceFiles: CONTEXT_FILES, onboardingPending: false };
}

export function readContextFile(name: string) {
  return CONTEXT_FILES.find((f) => f.name === name) ?? null;
}
