/**
 * papr.entities core: the app manifest (entities.json) and deterministic matching.
 *
 * A mini-app binds to a schema pack (e.g. papr/fundraising@^1) and maps its own
 * tables to pack entity types. The platform keeps two tables in each linked DB:
 *
 *   _papr_entities      entity_id, type, keys, facts, graph_node_id, synced_at
 *   _papr_entity_xref   (source_table, source_row) -> entity_id, plus legacy ids
 *
 * Matching is exact on normalized unique keys first (email, linkedin, domain),
 * then a normalized-name fallback that never merges across conflicting keys.
 * This mirrors the pack's server-side constraints, so the local copy and the
 * graph agree on identity.
 */

export const ENTITY_TYPES = ["Person", "Company", "Meeting", "Introduction", "Commitment", "Raise"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Keys we match on, per type, in priority order. "name" is the weak fallback. */
export const MATCH_KEYS: Record<EntityType, readonly string[]> = {
  Person: ["email", "linkedin", "name"],
  Company: ["domain", "name"],
  Meeting: ["meeting_key"],
  Introduction: ["intro_key"],
  Commitment: ["commitment_key"],
  Raise: ["name"],
};
const STRONG_KEYS = new Set(["email", "linkedin", "domain", "meeting_key", "intro_key", "commitment_key"]);

export interface EntityBinding {
  /** Data source alias in the app's data-sources.json */
  source: string;
  table: string;
  /** Primary key column of the app's row */
  key: string;
  /** entity key -> app column, e.g. { email: "email", name: "full_name" } */
  match: Record<string, string>;
  /** entity fact -> app column, copied into _papr_entities.facts */
  facts?: Record<string, string>;
  /** Legacy id columns to remember in the xref (e.g. investor_id, pitchbook_id) */
  legacyIds?: string[];
}

export interface EntitiesManifest {
  version: 1;
  /** Schema pack ref, e.g. "papr/fundraising@^1" */
  pack: string;
  /**
   * Data source that holds _papr_entities / _papr_entity_xref. Bindings may read
   * rows from other sources; identity is always resolved in this one. Apps that
   * share a registry DB and point home at it share one identity table.
   * Defaults to the first bound source.
   */
  home: string;
  /** shadow = resolve + report only, never write to the graph. live = also observe to memory. */
  mode: "shadow" | "live";
  uses: Partial<Record<EntityType, EntityBinding[]>>;
  /** Entity types this app may create facts for */
  writes?: EntityType[];
}

export class EntitiesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const PACK_REF = /^[a-z0-9_-]+\/[a-z0-9_-]+(@([\^~]?\d+(\.\d+){0,2}|latest))?$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateManifest(raw: unknown): EntitiesManifest {
  if (!raw || typeof raw !== "object") throw new EntitiesError("entities.json must be an object");
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) throw new EntitiesError("entities.json: version must be 1");
  if (typeof m.pack !== "string" || !PACK_REF.test(m.pack)) {
    throw new EntitiesError("entities.json: pack must be a schema pack ref like papr/fundraising@^1");
  }
  const mode = m.mode ?? "shadow";
  if (mode !== "shadow" && mode !== "live") throw new EntitiesError("entities.json: mode must be shadow or live");
  const uses = (m.uses ?? {}) as Record<string, unknown>;
  if (typeof uses !== "object") throw new EntitiesError("entities.json: uses must be an object");
  const out: EntitiesManifest = { version: 1, pack: m.pack, home: "", mode, uses: {} };
  for (const [type, bindings] of Object.entries(uses)) {
    if (!(ENTITY_TYPES as readonly string[]).includes(type)) {
      throw new EntitiesError(`entities.json: unknown entity type '${type}' (allowed: ${ENTITY_TYPES.join(", ")})`);
    }
    const list = Array.isArray(bindings) ? bindings : [bindings];
    out.uses[type as EntityType] = list.map((b, i) => validateBinding(type as EntityType, b, `uses.${type}[${i}]`));
  }
  const sources = Object.values(out.uses).flat().map((b) => b!.source);
  if (m.home !== undefined && (typeof m.home !== "string" || !m.home)) throw new EntitiesError("entities.json: home must be a data source alias");
  out.home = (m.home as string | undefined) ?? sources[0] ?? "";
  if (m.writes !== undefined) {
    if (!Array.isArray(m.writes) || m.writes.some((w) => !(ENTITY_TYPES as readonly string[]).includes(w as string))) {
      throw new EntitiesError("entities.json: writes must be a list of entity types");
    }
    out.writes = m.writes as EntityType[];
  }
  return out;
}

function validateBinding(type: EntityType, raw: unknown, at: string): EntityBinding {
  const b = (raw ?? {}) as Record<string, unknown>;
  for (const f of ["source", "table", "key"] as const) {
    if (typeof b[f] !== "string" || !b[f]) throw new EntitiesError(`entities.json ${at}: ${f} is required`);
  }
  for (const f of ["table", "key"] as const) {
    if (!IDENT.test(b[f] as string)) throw new EntitiesError(`entities.json ${at}: ${f} must be a plain column/table name`);
  }
  if ((b.table as string).startsWith("_papr_")) throw new EntitiesError(`entities.json ${at}: cannot bind platform tables`);
  const match = (b.match ?? {}) as Record<string, string>;
  const allowed = MATCH_KEYS[type];
  const keys = Object.keys(match);
  if (!keys.length) throw new EntitiesError(`entities.json ${at}: match needs at least one of ${allowed.join(", ")}`);
  for (const [k, col] of Object.entries(match)) {
    if (!allowed.includes(k)) throw new EntitiesError(`entities.json ${at}: '${k}' is not a match key for ${type} (${allowed.join(", ")})`);
    if (typeof col !== "string" || !IDENT.test(col)) throw new EntitiesError(`entities.json ${at}: match.${k} must be a column name`);
  }
  const facts = (b.facts ?? {}) as Record<string, string>;
  for (const [k, col] of Object.entries(facts)) {
    if (!IDENT.test(k) || typeof col !== "string" || !IDENT.test(col)) {
      throw new EntitiesError(`entities.json ${at}: facts.${k} must map to a column name`);
    }
  }
  const legacyIds = (b.legacyIds ?? []) as string[];
  if (!Array.isArray(legacyIds) || legacyIds.some((c) => typeof c !== "string" || !IDENT.test(c))) {
    throw new EntitiesError(`entities.json ${at}: legacyIds must be column names`);
  }
  return {
    source: b.source as string,
    table: b.table as string,
    key: b.key as string,
    match,
    ...(Object.keys(facts).length ? { facts } : {}),
    ...(legacyIds.length ? { legacyIds } : {}),
  };
}

// ── normalization ──────────────────────────────────────────────────────────

const NAME_NOISE = /\b(venture partners|ventures|venture|capital|partners|vc|fund|management|llc|inc|lp|ltd|group|the)\b/g;

export function normalizeKey(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let v = String(value).trim().toLowerCase();
  if (!v) return null;
  switch (key) {
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
    case "linkedin": {
      const m = v.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/);
      return m ? `${m[1]}/${decodeURIComponent(m[2]).replace(/\/$/, "")}` : null;
    }
    case "domain":
      v = v.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
      return v.includes(".") ? v : null;
    case "name":
      return v.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() || null;
    default:
      return v;
  }
}

/** Name key for companies drops "Ventures", "Capital", "Partners"... so "Norwest" == "Norwest Venture Partners". */
export function nameKey(type: EntityType, value: unknown): string | null {
  const n = normalizeKey("name", value);
  if (!n) return null;
  if (type !== "Company") return n;
  return n.replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim() || n;
}

export type EntityKeys = Partial<Record<string, string>>;

export function keysFromRow(type: EntityType, binding: EntityBinding, row: Record<string, unknown>): EntityKeys {
  const keys: EntityKeys = {};
  for (const [k, col] of Object.entries(binding.match)) {
    const v = k === "name" ? nameKey(type, row[col]) : normalizeKey(k, row[col]);
    if (v) keys[k] = v;
  }
  return keys;
}

export interface Candidate {
  entityId: string;
  keys: EntityKeys;
}

export interface MatchResult {
  entityId: string | null;
  confidence: number;
  via: string | null;
  /** Could not decide: the row is left unlinked and reported for review. */
  conflict?: string;
  /** Informational: e.g. same name as an existing entity but a different email, so treated as new. */
  note?: string;
}

/**
 * Deterministic match: any shared strong key wins (confidence 1). Name only
 * matches when neither side has a conflicting strong key of the same kind.
 */
export function matchEntity(type: EntityType, keys: EntityKeys, candidates: Candidate[]): MatchResult {
  const order = MATCH_KEYS[type];
  for (const k of order) {
    if (!STRONG_KEYS.has(k) || !keys[k]) continue;
    const hit = candidates.find((c) => c.keys[k] === keys[k]);
    if (hit) return { entityId: hit.entityId, confidence: 1, via: k };
  }
  if (keys.name) {
    const byName = candidates.filter((c) => c.keys.name === keys.name);
    const compatible = byName.filter((c) =>
      order.every((k) => !STRONG_KEYS.has(k) || !keys[k] || !c.keys[k] || keys[k] === c.keys[k]),
    );
    if (compatible.length === 1) return { entityId: compatible[0]!.entityId, confidence: 0.8, via: "name" };
    if (compatible.length > 1) return { entityId: null, confidence: 0, via: null, conflict: `ambiguous name: ${compatible.length} candidates` };
    // Same name but a different email/domain: a different entity, never a merge.
    if (byName.length) return { entityId: null, confidence: 0, via: null, note: "same name, different email/domain" };
  }
  return { entityId: null, confidence: 0, via: null };
}

export function mergeKeys(a: EntityKeys, b: EntityKeys): EntityKeys {
  const out: EntityKeys = { ...a };
  for (const [k, v] of Object.entries(b)) if (v && !out[k]) out[k] = v;
  return out;
}

export function newEntityId(type: EntityType, keys: EntityKeys): string {
  const basis = MATCH_KEYS[type].map((k) => keys[k]).find(Boolean) ?? `${Date.now()}-${Math.random()}`;
  let h = 0x811c9dc5;
  for (const ch of `${type}:${basis}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `ent_${type.toLowerCase()}_${h.toString(36)}`;
}
