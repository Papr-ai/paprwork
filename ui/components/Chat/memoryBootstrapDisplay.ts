/**
 * Parse Papr memory bootstrap blocks for human-readable Context Inspector display.
 * The raw blocks are user messages sent to the model (markdown-ish text).
 */

export interface ParsedMemoryItem {
  category: string | null;
  memoryType: string | null;
  sessionId: string | null;
  title: string | null;
  body: string;
}

export interface ParsedMemorySection {
  title: string;
  items: ParsedMemoryItem[];
}

export interface ParsedMemoryBlock {
  kind: "parse_goals" | "parse_usecases" | "sync_tiers" | "related_memory";
  intro: string;
  sections: ParsedMemorySection[];
  footer: string | null;
  truncated: boolean;
}

const MEMORY_ITEM_SPLIT = /\n(?=- \[[^\]]*\])/;
const TIER0_MARKER =
  "**Tier 0 — Priority memories (Papr-ranked; may include goals, OKRs, or conversation summaries):**";
const TIER1_MARKER = "**Tier 1 — Recent / hot memories:**";

function extractSessionId(body: string): string | null {
  const match = body.match(/Session:\s*([^\n]+)/);
  return match?.[1]?.trim() ?? null;
}

function extractTitle(body: string): string | null {
  const hash = body.match(/^#\s+(.+)$/m);
  if (hash?.[1]) {
    return hash[1].trim();
  }
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim().slice(0, 120) ?? null;
}

function parseMemoryItemChunk(chunk: string): ParsedMemoryItem | null {
  const trimmed = chunk.trim();
  if (!trimmed.startsWith("- ")) {
    return null;
  }

  const rest = trimmed.slice(2);
  const metaMatch = rest.match(/^\[([^\]]*)\]\s+\(([^)]*)\)\s+([\s\S]*)$/);
  if (!metaMatch) {
    return {
      category: null,
      memoryType: null,
      sessionId: null,
      title: extractTitle(rest),
      body: rest,
    };
  }

  const itemBody = metaMatch[3].trim();
  return {
    category: metaMatch[1] || null,
    memoryType: metaMatch[2] || null,
    sessionId: extractSessionId(itemBody),
    title: extractTitle(itemBody),
    body: itemBody,
  };
}

function parseItems(sectionBody: string): ParsedMemoryItem[] {
  return sectionBody
    .split(MEMORY_ITEM_SPLIT)
    .map(parseMemoryItemChunk)
    .filter((item): item is ParsedMemoryItem => item !== null);
}

function parseSections(
  body: string,
  defaultSectionTitle: string,
): ParsedMemorySection[] {
  const sections: ParsedMemorySection[] = [];

  if (body.includes(TIER0_MARKER)) {
    const tier0Start = body.indexOf(TIER0_MARKER) + TIER0_MARKER.length;
    const tier1Start = body.indexOf(TIER1_MARKER);
    const tier0Body =
      tier1Start >= 0 ? body.slice(tier0Start, tier1Start) : body.slice(tier0Start);
    const tier0Items = parseItems(tier0Body);
    if (tier0Items.length > 0) {
      sections.push({
        title: "Tier 0 — Priority memories",
        items: tier0Items,
      });
    }
  }

  if (body.includes(TIER1_MARKER)) {
    const tier1Body = body.slice(body.indexOf(TIER1_MARKER) + TIER1_MARKER.length);
    const tier1Items = parseItems(tier1Body);
    if (tier1Items.length > 0) {
      sections.push({
        title: "Tier 1 — Recent / hot memories",
        items: tier1Items,
      });
    }
  }

  if (sections.length === 0) {
    const items = parseItems(body);
    if (items.length > 0) {
      sections.push({ title: defaultSectionTitle, items });
    }
  }

  return sections;
}

function parseParseRecordSections(body: string, label: string): ParsedMemorySection[] {
  const chunks = body.split(/\n\n(?=\*\*)/).map((chunk) => chunk.trim()).filter(Boolean);
  const items: ParsedMemoryItem[] = chunks.map((chunk) => {
    const titleMatch = chunk.match(/^\*\*(.+?)\*\*/);
    const title = titleMatch?.[1]?.replace(/^Goal:\s*/, "").trim() ?? null;
    const itemBody = titleMatch ? chunk.slice(titleMatch[0].length).trim() : chunk;
    return {
      category: label,
      memoryType: null,
      sessionId: null,
      title,
      body: itemBody,
    };
  });

  if (items.length === 0) {
    return [];
  }

  return [{ title: label, items }];
}

export function parseMemoryBootstrapBlock(
  content: string,
  kind: "parse_goals" | "parse_usecases" | "sync_tiers" | "related_memory",
): ParsedMemoryBlock {
  const truncated = content.includes("[... truncated]");
  const lines = content.split("\n");
  const intro = lines[0]?.trim() ?? "";

  let footer: string | null = null;
  if (content.includes("Align your assistance with these goals")) {
    footer = "Align assistance with these goals when relevant.";
  } else if (content.includes("how the user applies Papr")) {
    footer = "Use when planning workflows or features for this user.";
  } else if (content.includes("Use search_agent_memory")) {
    footer =
      "Use search_agent_memory for task-specific recall if you need more detail.";
  } else if (content.includes("These may be relevant")) {
    footer =
      "These may be relevant to this request. Call search_agent_memory for deeper recall.";
  }

  const introEnd = content.indexOf("\n\n");
  let body = introEnd >= 0 ? content.slice(introEnd + 2) : content;
  if (footer) {
    const footerIdx = body.lastIndexOf("\n\n");
    if (footerIdx > 0) {
      const tail = body.slice(footerIdx + 2).trim();
      if (tail.startsWith("Use search") || tail.startsWith("These may")) {
        body = body.slice(0, footerIdx);
      }
    }
  }

  const defaultTitle =
    kind === "related_memory" ? "Matched to your message" : "Prioritized memories";

  const sections =
    kind === "parse_goals"
      ? parseParseRecordSections(body.trim(), "Goals & OKRs")
      : kind === "parse_usecases"
        ? parseParseRecordSections(body.trim(), "Use cases")
        : parseSections(body.trim(), defaultTitle);

  return {
    kind,
    intro,
    sections,
    footer,
    truncated,
  };
}
