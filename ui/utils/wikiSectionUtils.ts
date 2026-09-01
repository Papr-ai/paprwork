import type { WikiNode } from "../types/wiki";

export type OpenItemCategory = "user" | "agent" | "papr" | "uncategorized";

export const OPEN_ITEM_CATEGORY_ORDER: OpenItemCategory[] = [
  "user",
  "agent",
  "papr",
  "uncategorized",
];

export const OPEN_ITEM_CATEGORY_LABELS: Record<OpenItemCategory, string> = {
  user: "Your work",
  agent: "Agent",
  papr: "Papr configuration",
  uncategorized: "Uncategorized",
};


export function normalizeOpenItemCategory(
  raw: string | undefined,
): OpenItemCategory {
  if (!raw?.trim()) return "uncategorized";
  const tag = raw.trim().toLowerCase();
  if (tag === "config") return "papr";
  if (tag === "user" || tag === "agent" || tag === "papr") return tag;
  return "uncategorized";
}

export interface ParsedOpenItem {
  text: string;
  completed: boolean;
  rawLine: string;
  category: OpenItemCategory;
  /** Index among checkbox lines in the Open Items section (for persistence). */
  fileIndex: number;
}

export interface ParsedChangelogEntry {
  date: string;
  text: string;
  rawLine: string;
}

const WIKI_LINK_RE = /\[\[([a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*)(?:\|([^\]]+))?\]\]/gi;
const ENTITY_ID_RE = /^([a-z][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/i;

/** Human-readable relative or absolute updated time. */
export function formatUpdatedAt(value: string | undefined | null): string | null {
  if (!value?.trim()) return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return value.trim();
  const diffMs = Date.now() - ms;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (diffDays === 0) return "Updated today";
  if (diffDays === 1) return "Updated yesterday";
  if (diffDays < 7) return `Updated ${diffDays}d ago`;
  if (diffDays < 30) return `Updated ${Math.floor(diffDays / 7)}w ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Card-friendly label with consistent "Last updated" prefix. */
export function formatLastUpdated(value: string | undefined | null): string | null {
  const label = formatUpdatedAt(value);
  if (!label) return null;
  if (label.startsWith("Updated ")) {
    return `Last updated ${label.slice("Updated ".length)}`;
  }
  return `Last updated ${label}`;
}

/** Top-bar label for when the Wiki Writer job last ran. */
export function formatWikiJobLastUpdated(
  value: string | undefined | null,
): string | null {
  if (!value?.trim()) return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return null;
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return "Last updated at: just now";
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffHours < 1) return "Last updated at: just now";
  if (diffHours < 24) {
    return `Last updated at: ${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  if (diffDays === 1) return "Last updated at: 1 day ago";
  return `Last updated at: ${diffDays} days ago`;
}

/** Extract YYYY-MM-DD from daily log display names like `memory/2026-09-01.md (today)`. */
export function parseDailyLogDate(name: string): string | null {
  const match = name.match(/(\d{4}-\d{2}-\d{2})\.md/i);
  return match ? match[1] : null;
}

export function wikiNodeUpdatedAtMs(node: WikiNode): number {
  const raw = node.props?.updated_at ?? node.props?.updatedAt;
  if (raw == null) return 0;
  const ms = Date.parse(String(raw));
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortWikiNodesByUpdatedAt(nodes: WikiNode[]): WikiNode[] {
  return [...nodes].sort(
    (a, b) => wikiNodeUpdatedAtMs(b) - wikiNodeUpdatedAtMs(a),
  );
}

export function entityUpdatedAt(node: WikiNode): string | null {
  const raw = node.props?.updated_at ?? node.props?.updatedAt;
  return formatUpdatedAt(raw != null ? String(raw) : null);
}

const STUB_OPEN_ITEM_PATTERNS = [
  /enrich this entity with more context/i,
  /^no open items captured yet\.?$/i,
];

export function parseOpenItems(content: string): ParsedOpenItem[] {
  const items: ParsedOpenItem[] = [];
  let fileIndex = -1;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s*\[([xX ])\]\s*(.+)$/);
    if (!match) continue;
    fileIndex += 1;
    let tail = match[2].trim();
    let category: OpenItemCategory = "uncategorized";
    const categoryMatch = tail.match(/^\[(user|agent|papr|config)\]\s*(.*)$/i);
    if (categoryMatch) {
      category = normalizeOpenItemCategory(categoryMatch[1]);
      tail = categoryMatch[2].trim();
    }
    if (STUB_OPEN_ITEM_PATTERNS.some((pattern) => pattern.test(tail))) continue;
    items.push({
      completed: match[1].toLowerCase() === "x",
      text: tail,
      category,
      rawLine: line,
      fileIndex,
    });
  }
  return items;
}

export interface AggregatedOpenItem {
  entityType: string;
  entityId: string;
  entityLabel: string;
  entityRef: WikiNode;
  fileIndex: number;
  text: string;
  category: OpenItemCategory;
}

export function groupOpenItemsByCategory(
  items: AggregatedOpenItem[],
): Record<OpenItemCategory, AggregatedOpenItem[]> {
  const grouped: Record<OpenItemCategory, AggregatedOpenItem[]> = {
    user: [],
    agent: [],
    papr: [],
    uncategorized: [],
  };
  for (const item of items) {
    grouped[item.category].push(item);
  }
  return grouped;
}

/** Collect open (unchecked) items across entity wiki pages for Memory home + briefs. */
export function collectOpenItemsAcrossEntities(
  nodes: WikiNode[],
): AggregatedOpenItem[] {
  const aggregated: AggregatedOpenItem[] = [];
  for (const node of nodes) {
    const section = node.sections?.["Open Items"];
    if (!section?.trim()) continue;
    for (const item of parseOpenItems(section)) {
      if (item.completed) continue;
      aggregated.push({
        entityType: node.type,
        entityId: node.id,
        entityLabel: node.label,
        entityRef: {
          id: node.id,
          type: node.type,
          label: node.label,
          description: node.description ?? "",
          props: node.props ?? {},
        },
        fileIndex: item.fileIndex,
        text: item.text,
        category: item.category,
      });
    }
  }
  aggregated.sort((a, b) => {
    const parse = (value: unknown): number => {
      const ms = Date.parse(String(value ?? ""));
      return Number.isNaN(ms) ? 0 : ms;
    };
    return (
      parse(b.entityRef.props?.updated_at) - parse(a.entityRef.props?.updated_at)
    );
  });
  return aggregated;
}

export const KEY_DETAIL_HIDDEN_KEYS = new Set([
  "hero_image",
  "hero image",
  "updated_at",
  "updated at",
  "updatedat",
]);

export const KEY_DETAIL_LINK_KEYS = new Set(["website", "linkedin", "url"]);

export const KEY_DETAIL_IMAGE_KEYS = new Set([
  "image",
  "logo",
  "avatar",
  "photo",
]);

export interface ParsedKeyDetailRow {
  key: string;
  label: string;
  value: string;
}

export function parseKeyDetailRows(content: string): ParsedKeyDetailRow[] {
  const rows: ParsedKeyDetailRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s*([^:]+):\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim();
    const key = label.toLowerCase().replace(/\s+/g, "_");
    if (KEY_DETAIL_HIDDEN_KEYS.has(key) || KEY_DETAIL_HIDDEN_KEYS.has(label.toLowerCase())) {
      continue;
    }
    rows.push({ key, label, value: match[2].trim() });
  }
  return rows;
}

export function isKeyDetailImageValue(value: string): boolean {
  return (
    /^data:image\//i.test(value) ||
    /^https?:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(value)
  );
}

export interface ParsedDecision {
  status: "open" | "decided";
  text: string;
  owner?: string;
  evidence?: string;
  rawLine: string;
}

const IDENTITY_SECTION_PLACEHOLDERS: Record<string, RegExp[]> = {
  Goals: [/\(what the user wants/i, /^\([^)]+\)\.?$/m],
  "Current Projects": [/\(what the user is actively/i, /^\([^)]+\)\.?$/m],
  "Communication Style": [/\(tone preferences/i, /^\([^)]+\)\.?$/m],
  "Domain Context": [/\(industry-specific/i, /^\([^)]+\)\.?$/m],
  About: [/\(name, role, industry/i, /^\([^)]+\)\.?$/m],
};

export function isIdentitySectionPlaceholder(
  sectionTitle: string,
  content: string,
): boolean {
  const plain = content.trim();
  if (!plain) return true;
  const patterns = IDENTITY_SECTION_PLACEHOLDERS[sectionTitle];
  if (!patterns) return false;
  return patterns.some((pattern) => pattern.test(plain));
}

export function collectGoalNodes(nodes: WikiNode[]): WikiNode[] {
  return nodes.filter((node) => node.type === "goal");
}

/** Parse entity decision bullets written by Sleep / Wiki Writer. */
export function parseDecisions(content: string): ParsedDecision[] {
  const decisions: ParsedDecision[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const explicit = trimmed.match(
      /^[-*]\s*\[(open|decided)\]\s*(.+)$/i,
    );
    const checkbox = trimmed.match(/^[-*]\s*\[([xX ])\]\s*(.+)$/);
    const match = explicit ?? checkbox;
    if (!match) continue;

    let status: ParsedDecision["status"];
    let tail: string;
    if (explicit) {
      status = explicit[1].toLowerCase() === "decided" ? "decided" : "open";
      tail = explicit[2].trim();
    } else {
      status = checkbox![1].toLowerCase() === "x" ? "decided" : "open";
      tail = checkbox![2].trim();
    }

    const segments = tail.split(/\s—\s|\s\|\s/);
    const text = segments[0]?.trim() ?? tail;
    let owner: string | undefined;
    let evidence: string | undefined;
    for (const segment of segments.slice(1)) {
      const ownerMatch = segment.match(/^(?:\*\*)?Owner(?:\*\*)?:\s*(.+)$/i);
      const evidenceMatch = segment.match(
        /^(?:\*\*)?Evidence(?:\*\*)?:\s*(.+)$/i,
      );
      if (ownerMatch) owner = ownerMatch[1].trim();
      if (evidenceMatch) evidence = evidenceMatch[1].trim();
    }

    if (!text) continue;
    decisions.push({ status, text, owner, evidence, rawLine: line });
  }
  return decisions;
}

export function parseChangelogEntries(content: string): ParsedChangelogEntry[] {
  const entries: ParsedChangelogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const dated = trimmed.match(/^[-*]\s*(\S+)\s*[—–-]\s*(.+)$/);
    if (!dated) continue;
    entries.push({
      date: dated[1].replace(/\*\*/g, "").trim(),
      text: dated[2].trim(),
      rawLine: line,
    });
  }
  return entries.reverse();
}

export function parseWikiEntityRef(
  ref: string,
): { type: string; id: string; fullId: string } | null {
  const match = ref.trim().match(ENTITY_ID_RE);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const slug = match[2].toLowerCase();
  return { type, id: slug, fullId: `${type}/${slug}` };
}

export function resolveWikiNodeByRef(
  ref: string,
  allNodes: WikiNode[],
): WikiNode | null {
  const parsed = parseWikiEntityRef(ref);
  if (!parsed) return null;
  return (
    allNodes.find(
      (node) =>
        node.id === parsed.fullId ||
        node.id === parsed.id ||
        node.id.endsWith(`/${parsed.id}`),
    ) ?? null
  );
}

export interface RichTextSegment {
  kind: "text" | "entity";
  value: string;
  entityRef?: string;
  entityLabel?: string;
}

/** Split markdown-ish text into plain segments and [[type/id]] entity links. */
export function splitEntityMentions(text: string): RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({
      kind: "entity",
      value: match[0],
      entityRef: match[1],
      entityLabel: match[2]?.trim(),
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments.length ? segments : [{ kind: "text", value: text }];
}

export const STRUCTURED_SECTION_ORDER = [
  "Context & Background",
  "Key Details",
  "Key Interactions",
  "Decisions & Insights",
  "Open Items",
  "Changelog",
] as const;

export type StructuredSectionTitle = (typeof STRUCTURED_SECTION_ORDER)[number];

export function isPlaceholderSection(title: string, content: string): boolean {
  const plain = content.trim().toLowerCase();
  if (!plain) return true;
  if (title === "Open Items") {
    if (plain.includes("no open items")) return true;
    return parseOpenItems(content).length === 0;
  }
  if (title === "Key Details") {
    return parseKeyDetailRows(content).length === 0;
  }
  if (title === "Changelog") {
    if (plain.includes("no changelog")) return true;
    return parseChangelogEntries(content).length === 0;
  }
  if (title === "Decisions & Insights") {
    if (plain.includes("no durable decisions")) return true;
    if (plain.includes("no decisions or insights")) return true;
    return parseDecisions(content).length === 0;
  }
  if (title === "Key Interactions" && plain.includes("no interactions captured"))
    return true;
  return false;
}
