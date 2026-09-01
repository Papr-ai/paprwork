export interface WikiRelationship {
  type: string;
  target: string;
  context?: string;
  since?: string;
}

export interface WikiEvidence {
  id?: string;
  date: string;
  source: string;
  summary: string;
  chat?: string;
}

export interface WikiNode {
  id: string;
  type: string;
  label: string;
  description: string;
  props: Record<string, string | number | boolean>;
  /** Raw markdown body (everything after YAML frontmatter) */
  markdownBody?: string;
  /** Rich markdown sections from entity .md files */
  sections?: Record<string, string>;
  /** Typed relationships parsed from YAML frontmatter */
  relationships?: WikiRelationship[];
  /** Evidence trail with dates and sources */
  evidence?: WikiEvidence[];
}

export interface WikiEdge {
  from: string;
  to: string;
  type: string;
}

export interface WikiRail {
  title: string;
  reason?: string;
  items: WikiNode[];
}

export interface WikiHomeData {
  featured: WikiNode | null;
  rails: WikiRail[];
  typeCounts: Record<string, number>;
  configured: boolean;
  error?: string;
  relatedMemories?: WikiRelatedMemory[];
  searchFallback?: boolean;
  /** ISO timestamp of the last Wiki Writer job run */
  wikiLastUpdatedAt?: string | null;
}

export interface WikiRelatedMemory {
  id: string;
  content: string;
  category?: string;
  createdAt?: string;
  relevanceScore?: number;
}


export interface WikiEntityData {
  node: WikiNode | null;
  edges: WikiEdge[];
  rails: WikiRail[];
  error?: string;
  relatedMemories?: WikiRelatedMemory[];
}

export const WIKI_TYPE_META: Record<
  string,
  { label: string; glyph: string; color: string }
> = {
  // Original types
  goal: { label: "Goal", glyph: "★", color: "#f59e0b" },
  project: { label: "Project", glyph: "◼", color: "#0080FF" },
  person: { label: "Person", glyph: "●", color: "#10b981" },
  memory: { label: "Memory", glyph: "▤", color: "#6366f1" },
  insight: { label: "Insight", glyph: "◇", color: "#06b6d4" },
  task: { label: "Task", glyph: "■", color: "#f97316" },
  entity: { label: "Entity", glyph: "◆", color: "#a855f7" },
  meeting: { label: "Meeting", glyph: "◉", color: "#a855f7" },
  decision: { label: "Decision", glyph: "◈", color: "#ef4444" },
  idea: { label: "Idea", glyph: "✦", color: "#eab308" },
  workflow: { label: "Workflow", glyph: "↻", color: "#0ea5e9" },
  // SleepV2 entity wiki types
  app: { label: "App", glyph: "◆", color: "#3b82f6" },
  company: { label: "Company", glyph: "▲", color: "#ec4899" },
  learning: { label: "Learning", glyph: "★", color: "#14b8a6" },
  collection: { label: "Collection", glyph: "◇", color: "#8b5cf6" },
  // Plural aliases
  apps: { label: "App", glyph: "◆", color: "#3b82f6" },
  companies: { label: "Company", glyph: "▲", color: "#ec4899" },
  learnings: { label: "Learning", glyph: "★", color: "#14b8a6" },
  collections: { label: "Collection", glyph: "◇", color: "#8b5cf6" },
  meetings: { label: "Meeting", glyph: "◉", color: "#a855f7" },
  decisions: { label: "Decision", glyph: "◈", color: "#ef4444" },
  ideas: { label: "Idea", glyph: "✦", color: "#eab308" },
  workflows: { label: "Workflow", glyph: "↻", color: "#0ea5e9" },
  people: { label: "Person", glyph: "●", color: "#10b981" },
  projects: { label: "Project", glyph: "◼", color: "#0080FF" },
};

export function wikiTypeMeta(type: string): {
  label: string;
  glyph: string;
  color: string;
} {
  return (
    WIKI_TYPE_META[type] ?? {
      label: type.charAt(0).toUpperCase() + type.slice(1),
      glyph: "◆",
      color: "hsl(220 20% 55%)",
    }
  );
}

export function evidenceSortKey(date: string): number {
  const trimmed = date.trim();
  if (!trimmed) return 0;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortWikiEvidenceNewestFirst(evidence: WikiEvidence[]): WikiEvidence[] {
  return [...evidence].sort(
    (a, b) => evidenceSortKey(b.date) - evidenceSortKey(a.date),
  );
}

/** Ensure partial/cached nodes are safe to render (sessionStorage, search hits). */
export function normalizeWikiNode(
  node: Pick<WikiNode, "id" | "type" | "label"> & Partial<WikiNode>,
): WikiNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label ?? node.id,
    description: node.description ?? "",
    props: node.props ?? {},
    markdownBody: node.markdownBody,
    sections: node.sections,
    relationships: node.relationships,
    evidence: node.evidence?.length
      ? sortWikiEvidenceNewestFirst(node.evidence)
      : node.evidence,
  };
}

/** Collect all nodes from home rails + featured for relationship navigation. */
export function collectWikiNodes(home: WikiHomeData | null): WikiNode[] {
  const seen = new Set<string>();
  const nodes: WikiNode[] = [];
  const push = (node: WikiNode | null | undefined) => {
    if (!node?.id) return;
    const key = `${node.type}:${node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push(normalizeWikiNode(node));
  };
  push(home?.featured ?? null);
  for (const rail of home?.rails ?? []) {
    for (const item of rail.items ?? []) {
      push(item);
    }
  }
  return nodes;
}
