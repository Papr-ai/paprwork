/**
 * papr.entities: one identity for the people, funds and meetings your app shares
 * with other apps and agents.
 *
 *   import { papr } from '/__papr__/papr-sdk.ts';
 *
 *   // Bind tables in entities.json (pack + table/column mapping), then:
 *   const report = await papr.entities.sync();                     // resolve all rows, see matches
 *   const scott = await papr.entities.forRow('investor_review', 'o_12');
 *   const { entityId } = await papr.entities.resolve('Person', { email: 'scott@nvp.com' });
 *   await papr.entities.observe({
 *     about: [{ type: 'Person', match: { email: 'scott@nvp.com' } }],
 *     text: 'Met Scott; asked for the data room.',
 *     source: { table: 'meetings', row: 'm_149' },
 *   });
 *
 * In "shadow" mode (the default) nothing is written to memory: observe() returns
 * what it WOULD write so you can check it. Switch entities.json to "live" after.
 */

export type EntityType = "Person" | "Company" | "Meeting" | "Introduction" | "Commitment" | "Raise";
export type EntityKeys = Partial<Record<string, string>>;

export interface Entity {
  entityId: string;
  type: EntityType;
  keys: EntityKeys;
  facts: Record<string, unknown>;
  graphNodeId: string | null;
  syncedAt: string | null;
  rows: Array<{ table: string; row: string; confidence: number; via: string | null; legacy: Record<string, unknown> }>;
}

export interface SyncReport {
  mode: "shadow" | "live";
  pack: string;
  /** Data source holding the identity tables */
  home: string;
  entities: Record<string, number>;
  /** Entities referenced by more than one of your rows: identity you gained across tables/DBs */
  sharedAcrossRows: number;
  bindings: Array<{ type: EntityType; table: string; rows: number; linked: number; created: number; unmatched: number; conflicts: Array<{ row: string; reason: string }> }>;
}

export interface ObserveInput {
  about: Array<{ type: EntityType; entityId?: string; match?: EntityKeys }>;
  text?: string;
  facts?: Record<string, unknown>;
  source?: { table?: string; row?: string };
  sourceId?: string;
}

async function call<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `Entities ${path} failed (${res.status})`);
  return json;
}

export const entities = {
  /** The app's validated entities.json. */
  manifest(): Promise<{ pack: string; home: string; mode: "shadow" | "live"; uses: Record<string, unknown> }> {
    return call("/api/entities/manifest", undefined, "GET");
  },
  /** Resolve every bound row; returns counts, links and conflicts. Safe to run repeatedly. */
  sync(opts: { limit?: number } = {}): Promise<SyncReport> {
    return call("/api/entities/sync", opts);
  },
  /** Entity id for match keys (email, linkedin, domain, name...). Never writes. */
  resolve(type: EntityType, match: EntityKeys, opts: { sourceId?: string } = {}): Promise<{ entityId: string | null; confidence: number; via: string | null; conflict?: string }> {
    return call("/api/entities/resolve", { type, match, ...opts });
  },
  async get(entityId: string, opts: { sourceId?: string } = {}): Promise<Entity | null> {
    return (await call<{ entity: Entity | null }>("/api/entities/get", { entityId, ...opts })).entity;
  },
  /** Entity linked to one of your rows. */
  async forRow(table: string, row: string | number, type?: EntityType, opts: { sourceId?: string } = {}): Promise<Entity | null> {
    return (await call<{ entity: Entity | null }>("/api/entities/get", { table, row, type, ...opts })).entity;
  },
  /** Record a fact about entities. Shadow mode returns wouldWrite and writes nothing. */
  observe(input: ObserveInput): Promise<{ mode: "shadow" | "live"; memoryId: string | null; resolved: Array<{ type: EntityType; entityId: string | null; via: string | null; conflict?: string }>; wouldWrite: unknown }> {
    return call("/api/entities/observe", input);
  },
};
