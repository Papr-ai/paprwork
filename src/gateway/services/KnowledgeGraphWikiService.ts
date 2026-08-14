/**
 * KnowledgeGraphWikiService — Hybrid wiki data for Memory view
 *
 * GraphQL for structured entity rails when available.
 * memory.search fallback when GraphQL auth/schema fails.
 */

import type Papr from "@papr/memory";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { getPaprClient, isPaprNotFoundError } from "../../core/tools/paprClient.js";
import {
  getMemoryScopeContext,
  paprMemorySearchScopeSpread,
} from "../utils/memoryScopeResolver.js";
import { buildMemorySearchScopeFields } from "../../core/utils/memoryScope.js";
import {
  isWikiRailExcluded,
  pickWikiLabel,
} from "./wikiGraphHelpers.js";
import { syncWikiGraphEntity } from "./wikiGraphEntitySync.js";
import {
  graphqlNameContainsWhere,
  graphqlStringEq,
  runInBatches,
  WIKI_HOME_REMOTE_CACHE_TTL_MS,
  WIKI_REMOTE_FETCH_BATCH_DELAY_MS,
  WIKI_REMOTE_FETCH_BATCH_SIZE,
  wrapWikiGraphQLSelection,
} from "./wikiGraphqlUtils.js";
import * as fs from "fs";
import * as path from "path";

interface WikiHomeRemoteCacheEntry {
  fetchedAt: number;
  key: string;
  result: WikiHomeResult;
}

let wikiHomeRemoteCache: WikiHomeRemoteCacheEntry | null = null;

/** Test hook — clear cached remote wiki home payload. */
export function clearWikiHomeRemoteCache(): void {
  wikiHomeRemoteCache = null;
}

function wikiHomeRemoteCacheKey(): string {
  const ctx = getMemoryScopeContext();
  return (
    [ctx.organizationId, ctx.namespaceId, ctx.userId]
      .filter(Boolean)
      .join(":") || "default"
  );
}

function getCachedWikiHomeRemote(): WikiHomeResult | null {
  const key = wikiHomeRemoteCacheKey();
  if (
    wikiHomeRemoteCache &&
    wikiHomeRemoteCache.key === key &&
    Date.now() - wikiHomeRemoteCache.fetchedAt < WIKI_HOME_REMOTE_CACHE_TTL_MS
  ) {
    console.log("[Wiki] Home (remote cache hit)");
    return wikiHomeRemoteCache.result;
  }
  return null;
}

function setCachedWikiHomeRemote(result: WikiHomeResult): void {
  wikiHomeRemoteCache = {
    fetchedAt: Date.now(),
    key: wikiHomeRemoteCacheKey(),
    result,
  };
}

function getEntitiesDir(): string { return path.join(getPaprWorkspaceDir(), "entities"); }

const ENTITY_DIR_CONFIG: Record<string, { railTitle: string; singular: string }> = {
  projects:    { railTitle: "Projects",    singular: "project" },
  apps:        { railTitle: "Apps",        singular: "app" },
  people:      { railTitle: "People",      singular: "person" },
  companies:   { railTitle: "Companies",   singular: "company" },
  meetings:    { railTitle: "Meetings",    singular: "meeting" },
  decisions:   { railTitle: "Decisions",   singular: "decision" },
  ideas:       { railTitle: "Ideas",       singular: "idea" },
  workflows:   { railTitle: "Workflows",   singular: "workflow" },
  learnings:   { railTitle: "Learnings",   singular: "learning" },
  collections: { railTitle: "Collections", singular: "collection" },
};

const ENTITY_RAIL_ORDER = [
  "collection",
  "project",
  "app",
  "company",
  "person",
  "meeting",
  "decision",
  "idea",
  "workflow",
  "learning",
] as const;

/** Resolve rail metadata for a folder under workspace/entities/. */
export function resolveEntityDirConfig(
  dirName: string,
): { railTitle: string; singular: string } {
  const known = ENTITY_DIR_CONFIG[dirName];
  if (known) {
    return known;
  }

  const singular = dirName.endsWith("s") ? dirName.slice(0, -1) : dirName;
  const railTitle =
    singular.charAt(0).toUpperCase() + singular.slice(1) +
    (singular.endsWith("s") ? "" : "s");

  return { railTitle, singular };
}

function railTitleForSingular(singular: string): string {
  const fromConfig = Object.values(ENTITY_DIR_CONFIG).find(
    (cfg) => cfg.singular === singular,
  );
  if (fromConfig) {
    return fromConfig.railTitle;
  }
  return (
    singular.charAt(0).toUpperCase() + singular.slice(1) +
    (singular.endsWith("s") ? "" : "s")
  );
}

function parseEntityFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey = "";
  let currentList: string[] = [];
  let inList = false;
  for (const line of lines) {
    const listItem = line.match(/^  - (.+)$/);
    if (listItem && inList) { currentList.push(listItem[1].trim()); continue; }
    if (inList) { result[currentKey] = currentList; inList = false; currentList = []; }
    const kv = line.match(/^(\w[\w_]*): (.+)$/);
    if (kv) { result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ""); currentKey = ""; continue; }
    const listStart = line.match(/^(\w[\w_]*):\s*$/);
    if (listStart) { currentKey = listStart[1]; inList = true; currentList = []; }
  }
  if (inList) result[currentKey] = currentList;
  return result;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Max on-disk size for an inlined entity image (256KB). Larger files are skipped
 *  rather than bloating every wiki home payload. */
const MAX_ENTITY_IMAGE_BYTES = 256 * 1024;

/**
 * Resolve an entity `image:` frontmatter value into something the renderer can use.
 *
 * The wiki UI renders `props.image` directly into an `<img src>`. Entity assets live
 * under `$PAPR_HOME/workspace/entities/assets/...`, which is outside any static route,
 * so a relative path like `../assets/companies/acme.png` resolves to nothing in the
 * renderer and the card silently falls back to a gradient placeholder.
 *
 * Absolute URLs and data URIs pass through untouched. Relative paths are read from
 * disk and inlined as a base64 data URI. Paths are constrained to the entities
 * directory so a malicious .md cannot exfiltrate arbitrary files.
 */
export function resolveEntityImage(raw: unknown, entityDir: string): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:|data:)/i.test(value)) return value;

  try {
    const entitiesRoot = path.resolve(getEntitiesDir());
    const abs = path.resolve(entityDir, value);
    // Containment check — never read outside the entities tree.
    if (abs !== entitiesRoot && !abs.startsWith(entitiesRoot + path.sep)) {
      console.warn(`[Wiki] Ignoring out-of-tree entity image: ${value}`);
      return null;
    }
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_ENTITY_IMAGE_BYTES) return null;
    const mime = IMAGE_MIME_BY_EXT[path.extname(abs).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  } catch (err) {
    console.warn(`[Wiki] Failed to resolve entity image ${value}:`, err);
    return null;
  }
}

function parseMarkdownSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const body = content.replace(/^---[\s\S]*?---\n/, "");
  // Split on ## headings — avoids regex truncation at blank lines
  const parts = body.split(/^## /m).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const title = part.substring(0, nl).trim();
    if (title.startsWith("#")) continue; // skip H1
    const sectionContent = part.substring(nl + 1).trim();
    if (title) sections[title] = sectionContent;
  }
  return sections;
}

function cleanYamlScalar(value: string): string {
  return value.trim().replace(/^[\"']|[\"']$/g, "");
}

function parseYamlListBlock(content: string, key: string): string[] {
  const match = content.match(new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^\\w[\\w_]*:|^---|(?![\\s\\S]))`, "m"));
  if (!match) return [];
  return match[1].split(/^  - /m).map((item) => item.trim()).filter(Boolean);
}

function parseEntityRelationships(content: string): Array<{ type: string; target: string; context?: string }> {
  const rels: Array<{ type: string; target: string; context?: string }> = [];
  const seen = new Set<string>();
  for (const item of parseYamlListBlock(content, "relationships")) {
    const t = item.match(/(?:^|\n)\s*type:\s*([^\n]+)/);
    const target = item.match(/(?:^|\n)\s*(?:target|id):\s*([^\n]+)/);
    const ctx = item.match(/(?:^|\n)\s*(?:context|role|summary):\s*([^\n]+)/);
    if (!t || !target) continue;
    const type = cleanYamlScalar(t[1]);
    const targetId = cleanYamlScalar(target[1]);
    const key = `${type}::${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rels.push({ type, target: targetId, context: ctx ? cleanYamlScalar(ctx[1]) : undefined });
  }
  return rels;
}

function parseEntityEvidence(content: string): Array<{ date: string; source: string; summary: string }> {
  const evidence: Array<{ date: string; source: string; summary: string }> = [];
  const seen = new Set<string>();
  for (const item of parseYamlListBlock(content, "evidence")) {
    const date = item.match(/(?:^|\n)\s*date:\s*([^\n]+)/);
    const source = item.match(/(?:^|\n)\s*source:\s*([^\n]+)/);
    const summary = item.match(/(?:^|\n)\s*summary:\s*([^\n]+)/);
    if (!date && !source && !summary) continue;
    const row = {
      date: date ? cleanYamlScalar(date[1]) : "",
      source: source ? cleanYamlScalar(source[1]) : "",
      summary: summary ? cleanYamlScalar(summary[1]) : "",
    };
    const key = `${row.date}::${row.source}::${row.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(row);
  }
  return evidence.sort((a, b) => {
    const parse = (d: string): number => {
      const ms = Date.parse(d.trim());
      return Number.isNaN(ms) ? 0 : ms;
    };
    return parse(b.date) - parse(a.date);
  });
}

export interface EntityFileNode extends WikiNode {
  markdownBody: string;
  sections: Record<string, string>;
  relationships: Array<{ type: string; target: string; context?: string }>;
  evidence: Array<{ date: string; source: string; summary: string }>;
}

function readEntityFilesSync(): { nodes: EntityFileNode[]; rails: WikiRail[]; typeCounts: Record<string, number> } {
  const nodes: EntityFileNode[] = [];
  const typeCounts: Record<string, number> = {};
  if (!fs.existsSync(getEntitiesDir())) return { nodes, rails: [], typeCounts };

  for (const typeDir of fs.readdirSync(getEntitiesDir())) {
    const cfg = resolveEntityDirConfig(typeDir);
    const dirPath = path.join(getEntitiesDir(), typeDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = fs.readFileSync(path.join(dirPath, file), "utf8");
        const fm = parseEntityFrontmatter(content);
        const sections = parseMarkdownSections(content);
        const markdownBody = content.replace(/^---[\s\S]*?---\n/, "").trim();
        const relationships = parseEntityRelationships(content);
        const evidence = parseEntityEvidence(content);
        const id = String(fm.id || file.replace(".md", ""));
        const resolvedImage = resolveEntityImage(fm.image, dirPath);
        nodes.push({
          id: `${cfg.singular}/${id}`,
          type: cfg.singular,
          label: String(fm.name || id),
          description: String(fm.description || sections["Context & Background"] || "").slice(0, 300),
          props: {
            ...(fm.status ? { status: String(fm.status) } : {}),
            ...(fm.confidence ? { confidence: String(fm.confidence) } : {}),
            ...(fm.created_at ? { created_at: String(fm.created_at) } : {}),
            ...(fm.updated_at ? { updated_at: String(fm.updated_at) } : {}),
            ...(fm.kind ? { kind: String(fm.kind) } : {}),
            ...(fm.app_id ? { app_id: String(fm.app_id) } : {}),
            // Visual + link identity — company logos, person avatars, profile links.
            // `image` is resolved to a data URI so it renders without a static
            // file server (entity assets live outside the app bundle).
            ...(resolvedImage ? { image: resolvedImage } : {}),
            ...(fm.role ? { role: String(fm.role) } : {}),
            ...(fm.title ? { title: String(fm.title) } : {}),
            ...(fm.website ? { website: String(fm.website) } : {}),
            ...(fm.linkedin ? { linkedin: String(fm.linkedin) } : {}),
          },
          markdownBody,
          sections,
          relationships,
          evidence,
        });
        typeCounts[cfg.singular] = (typeCounts[cfg.singular] || 0) + 1;
      } catch (err) {
        console.warn(`[Wiki] Failed to parse entity file ${file}:`, err);
      }
    }
  }

  nodes.sort((a, b) => b.relationships.length - a.relationships.length);

  const grouped = new Map<string, EntityFileNode[]>();
  for (const n of nodes) {
    const list = grouped.get(n.type) ?? [];
    list.push(n);
    grouped.set(n.type, list);
  }

  const knownOrder = ENTITY_RAIL_ORDER.filter((t) => grouped.has(t));
  const extraTypes = [...grouped.keys()]
    .filter((t) => !ENTITY_RAIL_ORDER.includes(t as (typeof ENTITY_RAIL_ORDER)[number]))
    .sort((a, b) => a.localeCompare(b));
  const railTypeOrder = [...knownOrder, ...extraTypes];

  const rails: WikiRail[] = railTypeOrder.map((t) => ({
    title: railTitleForSingular(t),
    items: grouped.get(t) ?? [],
  }));

  return { nodes, rails, typeCounts };
}

/** Search all local entity .md files by name, id, or description snippet. */
export function searchLocalWikiEntities(query: string): WikiNode[] {
  const { nodes } = readEntityFilesSync();
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return nodes.filter((node) => {
    const label = node.label.toLowerCase();
    const id = node.id.toLowerCase();
    const description = node.description.toLowerCase();
    return (
      label.includes(normalized) ||
      id.includes(normalized) ||
      description.includes(normalized)
    );
  });
}


export interface WikiNode {
  id: string;
  type: string;
  label: string;
  description: string;
  props: Record<string, string | number | boolean>;
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

export interface WikiHomeResult {
  featured: WikiNode | null;
  rails: WikiRail[];
  typeCounts: Record<string, number>;
  configured: boolean;
  error?: string;
  relatedMemories?: any[];
  /** True when rails came from semantic search instead of GraphQL */
  searchFallback?: boolean;
}

export interface WikiEntityResult {
  node: WikiNode | null;
  edges: WikiEdge[];
  rails: WikiRail[];
  error?: string;
  relatedMemories?: any[];
}

export interface WikiSearchResult {
  results: WikiNode[];
  error?: string;
  relatedMemories?: any[];
}

interface EntityTypeConfig {
  wikiType: string;
  graphqlPlural: string;
  label: string;
  railTitle: string;
  listQuery: string;
  detailQuery: (id: string) => string | null;
  graphqlHasId: boolean;
}

const MAX_RAIL_ITEMS = 12;
const MIN_SEARCH_MEMORIES = 10;

const ENTITY_CONFIGS: EntityTypeConfig[] = [
  {
    wikiType: "goal",
    graphqlPlural: "goals",
    label: "Goals",
    railTitle: "Your goals",
    graphqlHasId: false,
    listQuery: `goals(first: ${MAX_RAIL_ITEMS}) {
      status priority progress target_date updated_at created_at
    }`,
    detailQuery: (id) => {
      const eq = graphqlStringEq("description", id);
      if (!eq) return null;
      return `goals(where: { ${eq} }) {
      description status priority progress target_date updated_at created_at
      forGoalByUserTask { task_name description status priority }
    }`;
    },
  },
  {
    wikiType: "project",
    graphqlPlural: "projects",
    label: "Projects",
    railTitle: "Projects",
    graphqlHasId: true,
    listQuery: `projects(first: ${MAX_RAIL_ITEMS}) {
      id name description type updated_at
    }`,
    detailQuery: (id) => {
      const eq = graphqlStringEq("id", id);
      if (!eq) return null;
      return `projects(where: { ${eq} }) {
      id name description type updated_at
      containsMemory { id content title memory_category }
      containsTask { name description }
      containsInsight { description }
      managedByPerson { id name role }
      participantsPerson { id name role }
    }`;
    },
  },
  {
    wikiType: "person",
    graphqlPlural: "people",
    label: "People",
    railTitle: "People",
    graphqlHasId: true,
    listQuery: `people(first: ${MAX_RAIL_ITEMS}) {
      id name role description updated_at
    }`,
    detailQuery: (id) => {
      const eq = graphqlStringEq("id", id);
      if (!eq) return null;
      return `people(where: { ${eq} }) {
      id name role description updated_at
      participatedInProject { id name description }
      createdMemory { id content title }
    }`;
    },
  },
  {
    wikiType: "memory",
    graphqlPlural: "memories",
    label: "Memories",
    railTitle: "Recent memories",
    graphqlHasId: true,
    listQuery: `memories(first: ${MAX_RAIL_ITEMS}) {
      id content title memory_category memory_role topics updatedAt
    }`,
    detailQuery: (id) => {
      const eq = graphqlStringEq("id", id);
      if (!eq) return null;
      return `memories(where: { ${eq} }) {
      id content title memory_category memory_role topics updatedAt
      relatedToMemory { id content title }
      referencesProject { id name description }
      createdByPerson { id name role }
    }`;
    },
  },
  {
    wikiType: "insight",
    graphqlPlural: "userInsights",
    label: "Insights",
    railTitle: "Insights",
    graphqlHasId: false,
    listQuery: `userInsights(first: ${MAX_RAIL_ITEMS}) {
      content category timestamp created_at
    }`,
    detailQuery: (_id) => `userInsights {
      content category confidence context timestamp batch_id session_id created_at
      hasInsightByConversationBatch { batch_id session_id }
    }`,
  },
  {
    wikiType: "task",
    graphqlPlural: "userTasks",
    label: "Tasks",
    railTitle: "Tasks",
    graphqlHasId: false,
    listQuery: `userTasks(first: ${MAX_RAIL_ITEMS}) {
      task_name status priority created_at updated_at
    }`,
    detailQuery: (_id) => `userTasks {
      task_name description status priority outcome created_at updated_at session_id
      forProjectProject { id name description }
      forGoalGoal { description status }
      assignedToPerson { id name role }
    }`,
  },
];

const SEARCH_RAIL_QUERIES: Array<{
  query: string;
  wikiType: string;
  railTitle: string;
}> = [
  { query: "goals and objectives", wikiType: "goal", railTitle: "Your goals" },
  { query: "projects and initiatives", wikiType: "project", railTitle: "Projects" },
  { query: "people contacts stakeholders", wikiType: "person", railTitle: "People" },
  { query: "memories notes conversations", wikiType: "memory", railTitle: "Recent memories" },
  { query: "insights decisions learnings", wikiType: "insight", railTitle: "Insights" },
  { query: "tasks action items todos", wikiType: "task", railTitle: "Tasks" },
];

function isConversationBatchMemory(record: Record<string, unknown>): boolean {
  const content = asString(record.content ?? record.title ?? record.description);
  const batchId = asString(record.batch_id);
  const sessionId = asString(record.session_id);
  if (batchId || sessionId) return true;
  return (
    content.includes("Conversation Batch") ||
    content.startsWith("# Conversation Batch") ||
    /^Session:\s*[0-9a-f-]{36}/i.test(content)
  );
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pickDescription(record: Record<string, unknown>): string {
  const candidates = [
    record.description,
    record.content,
    record.context,
    record.decision_rationale,
    record.summary,
  ];
  for (const candidate of candidates) {
    const text = asString(candidate).trim();
    if (text) return text;
  }
  return "";
}

function syntheticNodeId(
  record: Record<string, unknown>,
  wikiType: string,
): string {
  const parts = [
    wikiType,
    asString(record.id),
    asString(record.task_name),
    asString(record.name),
    asString(record.description).slice(0, 80),
    asString(record.content).slice(0, 80),
    asString(record.batch_id),
    asString(record.session_id),
    asString(record.created_at),
    asString(record.timestamp),
  ].filter((part) => part.length > 0);

  const joined = parts.join("|") || `${wikiType}-${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < joined.length; i++) {
    hash = (hash * 31 + joined.charCodeAt(i)) >>> 0;
  }
  return `${wikiType}-${hash.toString(36)}`;
}

function coerceSearchRecord(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const props = raw.properties;
  if (typeof props === "object" && props !== null && !Array.isArray(props)) {
    const flat = { ...(props as Record<string, unknown>) };
    const nodeId =
      asString(flat.id) ||
      asString(raw.id) ||
      asString(flat.node_id) ||
      asString(flat.element_id);
    if (nodeId) flat.id = nodeId;
    const label = asString(raw.label ?? raw.type ?? flat.label ?? flat.type);
    if (label) {
      flat.label = label;
      if (!flat.type) flat.type = label;
    }
    return flat;
  }
  return raw;
}

function normalizeNode(
  record: Record<string, unknown>,
  wikiType: string,
): WikiNode {
  const props: Record<string, string | number | boolean> = {};
  const propKeys = [
    "status",
    "priority",
    "progress",
    "role",
    "type",
    "category",
    "confidence",
    "memory_category",
    "memory_role",
    "target_date",
    "outcome",
  ];
  for (const key of propKeys) {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      props[key] = value;
    }
  }

  return {
    id: asString(record.id) || syntheticNodeId(record, wikiType),
    type: wikiType,
    label: pickWikiLabel(record, wikiType),
    description: pickDescription(record),
    props,
  };
}

function inferWikiTypeFromRecord(record: Record<string, unknown>): string {
  const label = asString(record.label ?? record.type ?? record.node_type).toLowerCase();
  if (label.includes("goal") || record.target_date) return "goal";
  if (label.includes("person") || (record.role && record.name)) return "person";
  if (label.includes("project") || record.type === "project") return "project";
  if (label.includes("insight") || record.confidence) return "insight";
  if (label.includes("task") || record.task_name) return "task";
  if (
    label.includes("memory") ||
    record.memory_category ||
    record.content
  ) {
    return "memory";
  }
  return "entity";
}

function isRelationshipField(_fieldName: string, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  const first = value[0];
  return typeof first === "object" && first !== null && "id" in first;
}

function relationshipLabel(fieldName: string): string {
  return fieldName
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function extractEdgesAndRails(
  record: Record<string, unknown>,
  sourceId: string,
): { edges: WikiEdge[]; rails: WikiRail[] } {
  const edges: WikiEdge[] = [];
  const rails: WikiRail[] = [];

  for (const [fieldName, value] of Object.entries(record)) {
    if (!isRelationshipField(fieldName, value)) continue;

    const neighbors = (value as Record<string, unknown>[]).map((item) => {
      const neighborType = inferNeighborType(fieldName, item);
      return normalizeNode(item, neighborType);
    });

    for (const neighbor of neighbors) {
      edges.push({
        from: sourceId,
        to: neighbor.id,
        type: fieldName,
      });
    }

    if (neighbors.length > 0) {
      rails.push({
        title: relationshipLabel(fieldName),
        reason: "Connected in your knowledge graph",
        items: neighbors,
      });
    }
  }

  return { edges, rails };
}

function inferNeighborType(
  fieldName: string,
  record: Record<string, unknown>,
): string {
  if (fieldName.toLowerCase().includes("person")) return "person";
  if (fieldName.toLowerCase().includes("project")) return "project";
  if (fieldName.toLowerCase().includes("memory")) return "memory";
  if (fieldName.toLowerCase().includes("goal")) return "goal";
  if (fieldName.toLowerCase().includes("task")) return "task";
  if (fieldName.toLowerCase().includes("insight")) return "insight";
  if (record.task_name) return "task";
  if (record.memory_category || record.content) return "memory";
  if (record.role && record.name) return "person";
  if (record.status && record.description && !record.name) return "goal";
  return inferWikiTypeFromRecord(record);
}

function parseSearchPayload(response: unknown): {
  memories: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
} {
  const root = response as {
    data?: {
      memories?: Array<Record<string, unknown>>;
      nodes?: Array<Record<string, unknown>>;
    };
    memories?: Array<Record<string, unknown>>;
    nodes?: Array<Record<string, unknown>>;
  };
  return {
    memories: root.data?.memories ?? root.memories ?? [],
    nodes: root.data?.nodes ?? root.nodes ?? [],
  };
}

async function runGraphQL(
  client: Papr,
  query: string,
  label: string,
): Promise<Record<string, unknown> | null> {
  try {
    const wrappedQuery = wrapWikiGraphQLSelection(query);
    const raw = await client.graphql.query({
      body: { query: wrappedQuery },
    });
    const response = raw as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    };

    if (response.errors?.length) {
      const msg = response.errors.map((e) => e.message).join("; ");
      const hasRows = response.data
        ? Object.values(response.data).some(
            (value) => Array.isArray(value) && value.length > 0,
          )
        : false;
      if (hasRows) {
        console.warn(`[Wiki] GraphQL ${label} partial: ${msg}`);
        return response.data ?? null;
      }
      console.warn(`[Wiki] GraphQL ${label}: ${msg}`);
      return null;
    }

    return response.data ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Wiki] GraphQL ${label} failed: ${msg}`);
    return null;
  }
}

function mergeWikiRails(
  graphqlRails: WikiRail[],
  searchRails: WikiRail[],
): WikiRail[] {
  const byTitle = new Map<string, WikiRail>();

  for (const rail of graphqlRails) {
    byTitle.set(rail.title, { ...rail, items: [...rail.items] });
  }

  for (const rail of searchRails) {
    const existing = byTitle.get(rail.title);
    const seen = new Set(
      (existing?.items ?? []).map((item) => `${item.type}:${item.id}`),
    );
    const merged = existing ? [...existing.items] : [];

    for (const item of rail.items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    if (merged.length > 0) {
      byTitle.set(rail.title, {
        title: rail.title,
        reason: `${merged.length} in your graph`,
        items: merged.slice(0, MAX_RAIL_ITEMS),
      });
    }
  }

  return [...byTitle.values()].sort((a, b) => b.items.length - a.items.length);
}

function isConversationBatchNode(node: WikiNode): boolean {
  const content = `${node.label} ${node.description}`;
  return (
    content.includes("Conversation Batch") ||
    content.startsWith("# Conversation Batch") ||
    /^Session:\s*[0-9a-f-]{36}/i.test(content)
  );
}

function pickFeatured(rails: WikiRail[]): WikiNode | null {
  const priority = ["goal", "project", "person", "task", "insight", "memory"];
  for (const type of priority) {
    for (const rail of rails) {
      const match = rail.items.find((item) => {
        if (item.type !== type) return false;
        if (type === "memory" && isConversationBatchNode(item)) return false;
        return true;
      });
      if (match) return match;
    }
  }
  return rails[0]?.items[0] ?? null;
}

function buildRailsFromItems(
  grouped: Map<string, WikiNode[]>,
): { rails: WikiRail[]; typeCounts: Record<string, number> } {
  const rails: WikiRail[] = [];
  const typeCounts: Record<string, number> = {};

  for (const config of ENTITY_CONFIGS) {
    const items = (grouped.get(config.wikiType) ?? []).slice(0, MAX_RAIL_ITEMS);
    if (items.length === 0) continue;
    typeCounts[config.wikiType] = items.length;
    rails.push({
      title: config.railTitle,
      reason: `${items.length} in your graph`,
      items,
    });
  }

  const other = grouped.get("entity") ?? [];
  if (other.length > 0) {
    typeCounts.entity = other.length;
    rails.push({
      title: "Entities",
      reason: `${other.length} in your graph`,
      items: other.slice(0, MAX_RAIL_ITEMS),
    });
  }

  rails.sort((a, b) => b.items.length - a.items.length);
  return { rails, typeCounts };
}

function wikiGraphSearchScope(): {
  external_user_id?: string;
  search_acl?: { read: string[]; write?: string[] };
} {
  const ctx = getMemoryScopeContext();
  if (ctx.namespaceId) {
    return buildMemorySearchScopeFields("namespace", ctx);
  }
  return buildMemorySearchScopeFields("user", ctx);
}

async function fetchWikiHomeFromSearch(client: Papr): Promise<{
  rails: WikiRail[];
  typeCounts: Record<string, number>;
}> {
  const grouped = new Map<string, WikiNode[]>();
  const seen = new Set<string>();
  const searchScope = wikiGraphSearchScope();

  const addNode = (raw: Record<string, unknown>, wikiType: string) => {
    const record = coerceSearchRecord(raw);
    if (isWikiRailExcluded(record, wikiType)) return;
    const node = normalizeNode(record, wikiType);
    if (!node.id) return;
    const key = `${node.type}:${node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const list = grouped.get(node.type) ?? [];
    list.push(node);
    grouped.set(node.type, list);
  };

  await runInBatches(
    SEARCH_RAIL_QUERIES,
    WIKI_REMOTE_FETCH_BATCH_SIZE,
    WIKI_REMOTE_FETCH_BATCH_DELAY_MS,
    async ({ query, wikiType }) => {
      try {
        const response = await client.memory.search({
          query,
          ...searchScope,
          max_memories: MIN_SEARCH_MEMORIES,
          max_nodes: 12,
          enable_agentic_graph: true,
        });
        const { memories, nodes } = parseSearchPayload(response);
        // Entity rails: graph nodes only. Memories are text chunks, not Neo4j entities.
        if (wikiType === "memory") {
          for (const memory of memories) {
            if (isConversationBatchMemory(memory)) continue;
            addNode(memory, "memory");
          }
        } else {
          for (const node of nodes) {
            addNode(node, wikiType);
          }
        }
      } catch (error) {
        if (isPaprNotFoundError(error)) {
          return;
        }
        console.warn(
          `[Wiki] Search rail failed (${wikiType}):`,
          error instanceof Error ? error.message : error,
        );
      }
    },
  );

  if ([...grouped.values()].every((items) => items.length === 0)) {
    try {
      const response = await client.memory.search({
        query: "knowledge graph entities projects goals people",
        ...searchScope,
        max_memories: 20,
        max_nodes: 40,
        enable_agentic_graph: true,
      });
      const { memories, nodes } = parseSearchPayload(response);
      for (const node of nodes) {
        addNode(node, inferWikiTypeFromRecord(node));
      }
      for (const memory of memories) {
        if (isConversationBatchMemory(memory)) continue;
        addNode(memory, "memory");
      }
    } catch (error) {
      if (!isPaprNotFoundError(error)) {
        console.warn(
          "[Wiki] Broad search fallback failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  const result = buildRailsFromItems(grouped);
  const totalItems = result.rails.reduce((sum, rail) => sum + rail.items.length, 0);
  console.log(`[Wiki] Search loaded ${totalItems} items across ${result.rails.length} rails`);
  return result;
}

async function fetchWikiHomeFromGraphQL(client: Papr): Promise<{
  rails: WikiRail[];
  typeCounts: Record<string, number>;
  graphqlFailed: boolean;
}> {
  const rails: WikiRail[] = [];
  const typeCounts: Record<string, number> = {};
  let graphqlFailed = false;
  let graphRepairsRemaining = 8;

  await runInBatches(
    ENTITY_CONFIGS,
    WIKI_REMOTE_FETCH_BATCH_SIZE,
    WIKI_REMOTE_FETCH_BATCH_DELAY_MS,
    async (config) => {
      const data = await runGraphQL(
        client,
        config.listQuery,
        config.graphqlPlural,
      );
      if (!data) {
        graphqlFailed = true;
        return;
      }

      const rows = data[config.graphqlPlural];
      if (!Array.isArray(rows) || rows.length === 0) return;

      const filtered = rows
        .filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null,
        )
        .filter((row) => !isWikiRailExcluded(row, config.wikiType))
        .slice(0, MAX_RAIL_ITEMS);

      const items: WikiNode[] = [];
      for (const row of filtered) {
        const allowGraphRepair = graphRepairsRemaining > 0;
        const synced = await syncWikiGraphEntity(client, row, config.wikiType, {
          allowGraphRepair,
        });
        if (synced.graphRepaired) graphRepairsRemaining -= 1;
        items.push(normalizeNode(synced.record, config.wikiType));
      }

      typeCounts[config.wikiType] = items.length;
      rails.push({
        title: config.railTitle,
        reason: `${items.length} in your graph`,
        items,
      });
    },
  );

  rails.sort((a, b) => b.items.length - a.items.length);
  return { rails, typeCounts, graphqlFailed };
}

export async function fetchWikiHome(options?: {
  forceRefresh?: boolean;
}): Promise<WikiHomeResult> {
  // PRIMARY: entity .md files under the active org/namespace workspace:
  // {paprHome}/workspace/entities/ (paprHome from .active-workspace.json or PAPR_HOME)
  const entityResult = readEntityFilesSync();
  if (entityResult.nodes.length > 0) {
    const featured = pickFeatured(entityResult.rails);
    console.log(
      `[Wiki] Home (entity files): ${entityResult.nodes.length} nodes, ${entityResult.rails.length} rails from ${getEntitiesDir()}`,
    );
    return {
      featured,
      rails: entityResult.rails,
      typeCounts: entityResult.typeCounts,
      configured: true,
      searchFallback: false,
    };
  }

  console.log(
    `[Wiki] No local entities at ${getEntitiesDir()} — falling back to Papr GraphQL/search`,
  );

  if (!options?.forceRefresh) {
    const cached = getCachedWikiHomeRemote();
    if (cached) {
      return cached;
    }
  }

  // FALLBACK: Neo4j / Qdrant search (same namespace as PAPR_API_KEY)
  let client: Papr;
  try {
    client = await getPaprClient();
  } catch {
    return {
      featured: null,
      rails: [],
      typeCounts: {},
      configured: false,
      error: "Connect Papr in Settings → AI Models to browse your knowledge graph.",
    };
  }

  const graphqlResult = await fetchWikiHomeFromGraphQL(client);
  const searchResult = await fetchWikiHomeFromSearch(client);

  const rails = mergeWikiRails(graphqlResult.rails, searchResult.rails);
  const typeCounts = { ...searchResult.typeCounts, ...graphqlResult.typeCounts };
  const searchFallback = searchResult.rails.length > 0;
  const featured = pickFeatured(rails);

  console.log(
    `[Wiki] Home (fallback): ${rails.length} rails (graphql=${graphqlResult.rails.length}, search=${searchResult.rails.length})`,
  );

  const result: WikiHomeResult = {
    featured,
    rails,
    typeCounts,
    configured: true,
    searchFallback,
    ...(rails.length === 0 && graphqlResult.graphqlFailed
      ? {
          error:
            "Could not load your graph. Check your Papr connection and try refreshing.",
        }
      : {}),
  };

  setCachedWikiHomeRemote(result);
  return result;
}

async function _fetchWikiEntityBase(wikiType: string, id: string, label?: string): Promise<WikiEntityResult> {
  // PRIMARY: Check entity .md files first
  const { nodes: entityNodes } = readEntityFilesSync();
  // Match by full id (type/slug) or just slug
  const entityNode = entityNodes.find(
    (n) => n.id === id || n.id === `${wikiType}/${id}` || n.id.endsWith(`/${id}`)
  );
  if (entityNode) {
    const edges: WikiEdge[] = entityNode.relationships.map((r) => ({
      from: entityNode.id,
      to: r.target,
      type: r.type,
    }));

    // 1. Forward connections: entities referenced in this file's relationships
    const connectedIds = new Set(entityNode.relationships.map((r) => r.target));

    // 2. Reverse connections: other entity files that reference THIS entity
    //    (e.g., person files that mention this company in their relationships or body)
    const entityLabel = entityNode.label.toLowerCase();
    const entitySlug = entityNode.id.split("/").pop() ?? "";
    for (const other of entityNodes) {
      if (other.id === entityNode.id) continue;
      if (connectedIds.has(other.id)) continue;
      // Check if other entity's relationships point to this entity
      const pointsHere = other.relationships.some(
        (r) => r.target === entityNode.id || r.target.endsWith(`/${entitySlug}`)
      );
      // Check if other entity's body/description mentions this entity
      const mentionsLabel = (other.markdownBody ?? "").toLowerCase().includes(entityLabel)
        || (other.description ?? "").toLowerCase().includes(entityLabel);
      if (pointsHere || mentionsLabel) {
        connectedIds.add(other.id);
      }
    }

    const related = entityNodes.filter((n) => connectedIds.has(n.id) && n.id !== entityNode.id);
    const relGrouped = new Map<string, WikiNode[]>();
    for (const n of related) {
      const l = relGrouped.get(n.type) ?? [];
      l.push(n);
      relGrouped.set(n.type, l);
    }
    const rails: WikiRail[] = [...relGrouped.entries()].map(([type, items]) => ({
      title: railTitleForSingular(type),
      items,
    }));
    console.log(`[Wiki] Entity (file): ${entityNode.id} → ${edges.length} edges, ${rails.length} rails (${related.length} connected)`);

    return { node: entityNode, edges, rails };
  }

  // FALLBACK: Neo4j / Qdrant
  const config = ENTITY_CONFIGS.find((c) => c.wikiType === wikiType);
  if (!config) {
    return { node: null, edges: [], rails: [], error: `Unknown entity type: ${wikiType}` };
  }

  let client: Papr;
  try {
    client = await getPaprClient();
  } catch {
    return {
      node: null,
      edges: [],
      rails: [],
      error: "PAPR_API_KEY is not configured",
    };
  }

  if (config.graphqlHasId) {
    try {
      const selection = config.detailQuery(id);
      if (!selection) {
        console.warn(
          `[Wiki] Skipping GraphQL entity load — invalid id (${wikiType}/${id})`,
        );
      } else {
      const data = await runGraphQL(
        client,
        selection,
        `${config.graphqlPlural}:${id}`,
      );
      if (data) {
        const rows = data[config.graphqlPlural];
        if (Array.isArray(rows) && rows.length > 0) {
          const record = rows[0] as Record<string, unknown>;
          const synced = await syncWikiGraphEntity(client, record, wikiType);
          const node = normalizeNode(synced.record, wikiType);
          const { edges, rails } = extractEdgesAndRails(synced.record, node.id);
          return { node, edges, rails };
        }
      }
      }
    } catch (error) {
      console.warn(
        `[Wiki] GraphQL entity load failed (${wikiType}/${id}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const searchQuery = label?.trim() || id;
  const searchScope = await paprMemorySearchScopeSpread();
  try {
    const response = await client.memory.search({
      query: searchQuery,
      ...searchScope,
      max_memories: MIN_SEARCH_MEMORIES,
      max_nodes: 20,
      enable_agentic_graph: true,
    });
    const { memories, nodes } = parseSearchPayload(response);

    const candidates = [
      ...memories.map(coerceSearchRecord),
      ...nodes.map(coerceSearchRecord),
    ];

    const match =
      candidates.find((row) => asString(row.id) === id) ??
      candidates.find((row) => syntheticNodeId(row, wikiType) === id) ??
      candidates.find(
        (row) =>
          label &&
          pickWikiLabel(row, wikiType).toLowerCase() === label.toLowerCase(),
      ) ??
      candidates[0];

    if (match) {
      const synced = await syncWikiGraphEntity(client, match, wikiType);
      const node = normalizeNode(synced.record, wikiType);
      return { node, edges: [], rails: [] };
    }
  } catch {
    // fall through
  }

  return { node: null, edges: [], rails: [], error: "Entity not found" };
}

export async function fetchWikiEntity(
  wikiType: string,
  id: string,
  label?: string,
): Promise<WikiEntityResult> {
  const result = await _fetchWikiEntityBase(wikiType, id, label);
  if (!result.node) {
    return result;
  }

  // Run graph entity lookup + memory search in parallel
  const [graphRails, relatedMemories] = await Promise.all([
    _fetchGraphConnectedEntities(result.node, result.rails),
    _fetchRelatedMemories(result.node),
  ]);

  // Merge graph-discovered entities into existing rails
  const mergedRails = graphRails.length > 0
    ? mergeWikiRails(result.rails, graphRails)
    : result.rails;

  return {
    ...result,
    rails: mergedRails,
    relatedMemories,
  };
}

async function _fetchRelatedMemories(node: WikiNode): Promise<any[]> {
  try {
    const client = await getPaprClient();
    const query = [node.label, node.description].filter(Boolean).join(" ");
    if (!query) return [];
    const searchScope = await paprMemorySearchScopeSpread();
    const response = await client.memory.search({
      query,
      ...searchScope,
      max_memories: 20,
      enable_agentic_graph: false,
    });
    const { memories } = parseSearchPayload(response);
    return memories.map(m => ({
      id: asString(m.id),
      content: asString(m.content),
      category: asString(m.category),
      source: asString(m.source),
      createdAt: asString(m.created_at),
      chatId: asString(m.chat_id),
    })).filter(m => m.id && m.content);
  } catch (e) {
    console.warn("[Wiki] Failed to fetch related memories:", e);
    return [];
  }
}

async function _fetchGraphConnectedEntities(
  node: WikiNode,
  existingRails: WikiRail[],
): Promise<WikiRail[]> {
  try {
    const client = await getPaprClient();
    const entityType = node.type;
    const nameWhere = graphqlNameContainsWhere(node.label);
    const allRails: WikiRail[] = [];

    // --- Graph queries: best-effort, entity files are the primary source ---
    // Some Person nodes in the graph have corrupted fields that cause errors,
    // so we use safe queries (id-only for nested relationships) and tolerate failures.
    const graphType = entityType === "person" ? "people"
      : entityType === "company" ? "companies"
      : entityType === "project" ? "projects"
      : entityType === "goal" ? "goals"
      : null;

    if (graphType && nameWhere) {
      // For companies: get connection count, then fetch person IDs individually
      if (entityType === "company") {
        // Safe query: only get totalCount (no nested name fields that could error)
        const countQuery = `${graphType}(where: ${nameWhere}, limit: 1) { id name employeesPersonConnection { totalCount edges { node { id } } } }`;
        const data = await runGraphQL(client, countQuery, `connected-company-people`);
        if (data) {
          const records = (data[graphType] as Record<string, unknown>[]) ?? [];
          if (records.length > 0) {
            const conn = (records[0] as Record<string, unknown>).employeesPersonConnection as {
              totalCount?: number;
              edges?: Array<{ node: { id: string } }>;
            } | undefined;
            if (conn?.edges) {
              // Got person IDs — look up their names from entity files (reliable)
              const { nodes: entityNodes } = readEntityFilesSync();
              const personNodes: WikiNode[] = [];
              for (const edge of conn.edges) {
                if (!edge.node?.id) continue;
                // Try to find this person in entity files by graph ID or name
                const entityMatch = entityNodes.find((n) =>
                  n.type === "person" && (n.props.graph_id === edge.node.id)
                );
                if (entityMatch) {
                  personNodes.push(entityMatch);
                }
              }
              // Also try fetching names directly (may fail on corrupt nodes, that's OK)
              const nameQuery = `${graphType}(where: ${nameWhere}, limit: 1) { employeesPerson { id name } }`;
              const nameData = await runGraphQL(client, nameQuery, `connected-company-people-names`);
              if (nameData) {
                const recs = (nameData[graphType] as Record<string, unknown>[]) ?? [];
                if (recs.length > 0) {
                  const people = (recs[0] as Record<string, unknown>).employeesPerson as Record<string, unknown>[] | undefined;
                  if (people) {
                    for (const p of people) {
                      if (p.id && p.name && !personNodes.some((n) => n.id === String(p.id))) {
                        personNodes.push(normalizeNode(p, "person"));
                      }
                    }
                  }
                }
              }
              if (personNodes.length > 0) {
                allRails.push({
                  title: "People",
                  reason: `${conn.totalCount ?? personNodes.length} connected in knowledge graph`,
                  items: personNodes,
                });
              }
            }
          }
        }
      }

      // For people: find companies they work at
      if (entityType === "person") {
        const q = `${graphType}(where: ${nameWhere}, limit: 1) { id name worksAtCompany { id name } }`;
        const data = await runGraphQL(client, q, `connected-person-companies`);
        if (data) {
          const records = (data[graphType] as Record<string, unknown>[]) ?? [];
          if (records.length > 0) {
            const { rails: directRails } = extractEdgesAndRails(records[0], node.id);
            allRails.push(...directRails);
          }
        }
      }
    }

    // Deduplicate and filter out entities already shown
    const existingIds = new Set(
      existingRails.flatMap((r) => r.items.map((i) => i.id))
    );
    const result = allRails
      .map((rail) => ({
        ...rail,
        items: rail.items.filter((i) => !existingIds.has(i.id)),
      }))
      .filter((rail) => rail.items.length > 0);
    console.log(`[Wiki] Graph connected entities: ${result.reduce((s, r) => s + r.items.length, 0)} items across ${result.length} rails`);
    return result;
  } catch (e) {
    console.warn("[Wiki] Graph connected entities lookup failed:", e);
    return [];
  }
}


export async function searchWiki(query: string): Promise<WikiSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { results: [] };
  }

  let client: Papr;
  try {
    client = await getPaprClient();
  } catch {
    return { results: [], error: "PAPR_API_KEY is not configured" };
  }

  try {
    const searchScope = await paprMemorySearchScopeSpread();
    const response = await client.memory.search({
      query: trimmed,
      ...searchScope,
      max_memories: MIN_SEARCH_MEMORIES,
      max_nodes: 12,
      enable_agentic_graph: true,
    });

    const { memories, nodes } = parseSearchPayload(response);

    const seen = new Set<string>();
    const results: WikiNode[] = [];

    const pushResult = (raw: Record<string, unknown>, type: string) => {
      const record = coerceSearchRecord(raw);
      const node = normalizeNode(record, type);
      const key = `${node.type}:${node.id}`;
      if (!node.id || seen.has(key)) return;
      seen.add(key);
      results.push(node);
    };

    for (const node of nodes) {
      pushResult(node, inferWikiTypeFromRecord(node));
    }

    for (const memory of memories) {
      if (isConversationBatchMemory(memory)) continue;
      pushResult(memory, "memory");
    }

    return { results };
  } catch (error) {
    return {
      results: [],
      error: error instanceof Error ? error.message : "Search failed",
    };
  }
}

/* ── User-created entities and types ─────────────── */

export interface CreateWikiEntityOptions {
  appId?: string;
  kind?: string;
  source?: "user" | "create_app" | "wiki_sync";
}

export async function createWikiEntity(
  type: string,
  name: string,
  description: string,
  options: CreateWikiEntityOptions = {},
): Promise<{ id: string; filePath: string; created: boolean }> {
  const entitiesDir = path.join(getPaprWorkspaceDir(), "entities");
  const typeDir = path.join(entitiesDir, type);
  if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });

  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const filePath = path.join(typeDir, `${id}.md`);
  if (fs.existsSync(filePath)) {
    return { id, filePath, created: false };
  }

  const now = new Date().toISOString().split("T")[0];
  const source = options.source ?? "user";
  const sourceLabel =
    source === "create_app"
      ? "Auto-created when mini-app was shipped"
      : source === "wiki_sync"
        ? "Materialized from Papr graph sync"
        : "Entity created manually by user";

  const extraFrontmatter = [
    options.appId ? `app_id: ${options.appId}` : "",
    options.kind ? `kind: ${options.kind}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const content = `---
type: ${type}
id: ${id}
name: "${name.replace(/"/g, '\\"')}"
status: active
created: ${now}
updated: ${now}
confidence: 0.5
description_short: "${(description || name).replace(/"/g, '\\"')}"
${extraFrontmatter ? `${extraFrontmatter}\n` : ""}relationships: []
evidence: []
tags: []
quality:
  score: 0.5
  sections_complete: true
  evidence_count: 0
  relationship_count: 0
  last_reviewed: ${now}
---

# ${name}

${description || `A ${type} entity. The sleep agent will enrich this page with context from your memories, chats, and job data.`}

## Context & Background

${description || "No context captured yet. This entity was created manually and will be enriched by the sleep agent."}

## Key Details

- Type: ${type}
- Created: ${now}
- Status: active
${options.appId ? `- App id: \`${options.appId}\`\n` : ""}${options.kind ? `- Kind: ${options.kind}\n` : ""}
## Key Interactions

No interactions captured yet.

## Decisions & Insights

No decisions or insights captured yet.

## Open Items

- [ ] Enrich this entity with more context from memory and conversations

## Changelog

- ${now} — ${sourceLabel}
`;

  fs.writeFileSync(filePath, content, "utf-8");

  void import("./wikiLocalEntityGraphSync.js")
    .then(({ syncLocalWikiEntityToGraph }) =>
      syncLocalWikiEntityToGraph({
        entityDir: type,
        slug: id,
        name,
        description: description || name,
        appId: options.appId,
        kind: options.kind,
        source: options.source ?? "user",
      }),
    )
    .catch((error) => {
      console.warn(
        `[Wiki] Graph sync after createWikiEntity failed:`,
        error instanceof Error ? error.message : error,
      );
    });

  return { id, filePath, created: true };
}

export async function addWikiType(
  typeName: string,
  icon: string,
  description: string,
): Promise<{ typeName: string; dirCreated: boolean; configUpdated: boolean }> {
  const entitiesDir = path.join(getPaprWorkspaceDir(), "entities");
  const typeDir = path.join(entitiesDir, typeName);
  const dirCreated = !fs.existsSync(typeDir);
  if (dirCreated) fs.mkdirSync(typeDir, { recursive: true });

  // Update wiki-config.yaml if it exists
  const configPath = path.join(getPaprWorkspaceDir(), "wiki-config.yaml");
  let configUpdated = false;
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, "utf-8");
    // Check if type already exists
    const typeRegex = new RegExp(`^\\s+${typeName}:`, "m");
    if (!typeRegex.test(config)) {
      const entry = `
  ${typeName}:
    icon: "${icon}"
    description: "${description.replace(/"/g, '\\"')}"
    discovery_queries:
      - "${typeName} related topics discussions mentions"
    min_confidence: 0.5
`;
      // Append under entity_types
      const updated = config.replace(
        /^(entity_types:)/m,
        `$1${entry}`,
      );
      // If replace didn't work (no entity_types key), just append
      if (updated === config) {
        fs.appendFileSync(configPath, `\n${typeName}:\n  icon: "${icon}"\n  description: "${description}"\n`);
      } else {
        fs.writeFileSync(configPath, updated, "utf-8");
      }
      configUpdated = true;
    }
  }

  return { typeName, dirCreated, configUpdated };
}
