import Database from "better-sqlite3";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EntitiesError,
  keysFromRow,
  matchEntity,
  nameKey,
  newEntityId,
  normalizeKey,
  validateManifest,
  type EntitiesManifest,
} from "./entitiesCore.js";
import { buildObserveMemory, linkToFor } from "./entitiesGraph.js";
import { registerEntitiesRoutes } from "./entitiesRoutes.js";
import { entityForRow, getEntity, observe, resolveKeys, syncManifest, type GraphPort, type SqlPort } from "./entitiesStore.js";

function sqlite(): { db: Database.Database; port: SqlPort } {
  const db = new Database(":memory:");
  return {
    db,
    port: {
      query: async (sql, params = []) => db.prepare(sql).all(...(params as unknown[])) as Array<Record<string, unknown>>,
      run: async (sql, params = []) => {
        db.prepare(sql).run(...(params as unknown[]));
      },
      exec: async (sql) => {
        db.exec(sql);
      },
    },
  };
}

/** Investor-shaped fixture: the same people appear in Data Room and Investor Review. */
function seed(db: Database.Database): void {
  db.exec(`
    CREATE TABLE vc_partners (id TEXT PRIMARY KEY, investor_id TEXT, name TEXT, email TEXT, linkedin_url TEXT, title TEXT, pitchbook_id TEXT);
    CREATE TABLE investors (id TEXT PRIMARY KEY, name TEXT, fund_url TEXT, stage TEXT, attio_record_id TEXT);
    CREATE TABLE investor_review (outreach_id TEXT PRIMARY KEY, investor_id TEXT, full_name TEXT, email TEXT, linkedin_url TEXT, fund TEXT, fund_url TEXT);
    INSERT INTO investors VALUES
      ('norwest', 'Norwest Venture Partners', 'https://www.nvp.com/', 'seed', 'att_1'),
      ('sancus', 'Sancus Ventures', 'sancus.vc', 'pre-seed', NULL),
      ('blank', 'Mystery Fund', NULL, NULL, NULL);
    INSERT INTO vc_partners VALUES
      ('p1', 'norwest', 'Scott Beechuk', 'Scott@NVP.com', 'https://www.linkedin.com/in/scottbeechuk/', 'Partner', 'pb_9'),
      ('p2', 'sancus', 'Jane Doe', NULL, 'linkedin.com/in/janedoe', 'GP', NULL),
      ('p3', 'sancus', 'Alex Kim', 'alex@a.com', NULL, 'Principal', NULL),
      ('p4', 'other', 'Alex Kim', 'alex@b.com', NULL, 'Associate', NULL);
    INSERT INTO investor_review VALUES
      ('o1', 'norwest', 'Scott Beechuk', 'scott@nvp.com', NULL, 'Norwest', 'nvp.com'),
      ('o2', 'sancus', 'Jane Doe', NULL, 'https://linkedin.com/in/janedoe?trk=x', 'Sancus', 'https://sancus.vc'),
      ('o3', 'ghost', 'Alex Kim', NULL, NULL, 'Ghost VC', NULL);
  `);
}

const MANIFEST: EntitiesManifest = validateManifest({
  version: 1,
  pack: "papr/fundraising@^1",
  mode: "shadow",
  uses: {
    Person: [
      { source: "dataroom", table: "vc_partners", key: "id", match: { email: "email", linkedin: "linkedin_url", name: "name" }, facts: { title: "title" }, legacyIds: ["pitchbook_id"] },
      { source: "dataroom", table: "investor_review", key: "outreach_id", match: { email: "email", linkedin: "linkedin_url", name: "full_name" } },
    ],
    Company: [
      { source: "dataroom", table: "investors", key: "id", match: { domain: "fund_url", name: "name" }, facts: { stage: "stage" }, legacyIds: ["attio_record_id"] },
      { source: "dataroom", table: "investor_review", key: "outreach_id", match: { domain: "fund_url", name: "fund" } },
    ],
  },
  writes: ["Meeting"],
});

describe("normalization", () => {
  it("normalizes emails, LinkedIn URLs and domains", () => {
    expect(normalizeKey("email", " Scott@NVP.com ")).toBe("scott@nvp.com");
    expect(normalizeKey("email", "not-an-email")).toBeNull();
    expect(normalizeKey("linkedin", "https://www.linkedin.com/in/scottbeechuk/")).toBe("in/scottbeechuk");
    expect(normalizeKey("linkedin", "linkedin.com/in/janedoe?trk=x")).toBe("in/janedoe");
    expect(normalizeKey("domain", "https://www.nvp.com/team")).toBe("nvp.com");
    expect(normalizeKey("domain", "Norwest")).toBeNull();
  });

  it("company names drop fund suffixes so Norwest == Norwest Venture Partners", () => {
    expect(nameKey("Company", "Norwest Venture Partners")).toBe(nameKey("Company", "Norwest"));
    expect(nameKey("Company", "Sancus Ventures")).toBe("sancus");
    expect(nameKey("Person", "Scott  Beechuk")).toBe("scott beechuk");
  });

  it("ids are deterministic per strongest key", () => {
    expect(newEntityId("Person", { email: "a@b.com" })).toBe(newEntityId("Person", { email: "a@b.com", name: "x" }));
    expect(newEntityId("Person", { email: "a@b.com" })).not.toBe(newEntityId("Company", { email: "a@b.com" }));
  });
});

describe("matching", () => {
  const cands = [
    { entityId: "e1", keys: { email: "scott@nvp.com", name: "scott beechuk" } },
    { entityId: "e2", keys: { email: "alex@a.com", name: "alex kim" } },
    { entityId: "e3", keys: { email: "alex@b.com", name: "alex kim" } },
  ];
  it("strong key wins with confidence 1", () => {
    expect(matchEntity("Person", { email: "scott@nvp.com" }, cands)).toMatchObject({ entityId: "e1", confidence: 1, via: "email" });
  });
  it("name alone links when unique", () => {
    expect(matchEntity("Person", { name: "scott beechuk" }, cands)).toMatchObject({ entityId: "e1", via: "name", confidence: 0.8 });
  });
  it("ambiguous names never auto-merge", () => {
    const m = matchEntity("Person", { name: "alex kim" }, cands);
    expect(m.entityId).toBeNull();
    expect(m.conflict).toMatch(/ambiguous/);
  });
  it("same name but different email is a new entity, never a merge", () => {
    const m = matchEntity("Person", { name: "scott beechuk", email: "scott@other.com" }, cands);
    expect(m.entityId).toBeNull();
    expect(m.conflict).toBeUndefined();
    expect(m.note).toMatch(/different/);
  });
});

describe("manifest validation", () => {
  it("accepts the investor manifest, defaults to shadow and home = first source", () => {
    const m = validateManifest({ version: 1, pack: "papr/fundraising@^1", uses: { Person: { source: "r", table: "t", key: "id", match: { email: "email" } } } });
    expect(m.mode).toBe("shadow");
    expect(m.home).toBe("r");
    expect(m.uses.Person).toHaveLength(1);
    expect(validateManifest({ version: 1, pack: "papr/f", home: "dataroom", uses: {} }).home).toBe("dataroom");
  });
  it.each([
    [{ version: 2, pack: "papr/fundraising" }, /version/],
    [{ version: 1, pack: "fundraising" }, /pack/],
    [{ version: 1, pack: "papr/f", uses: { Robot: [] } }, /unknown entity type/],
    [{ version: 1, pack: "papr/f", uses: { Person: { source: "r", table: "t", key: "id", match: { domain: "d" } } } }, /not a match key/],
    [{ version: 1, pack: "papr/f", uses: { Person: { source: "r", table: "t; DROP", key: "id", match: { email: "e" } } } }, /plain column/],
    [{ version: 1, pack: "papr/f", uses: { Person: { source: "r", table: "_papr_entities", key: "id", match: { email: "e" } } } }, /platform tables/],
    [{ version: 1, pack: "papr/f", mode: "yolo" }, /mode/],
  ])("rejects %j", (raw, err) => {
    expect(() => validateManifest(raw)).toThrow(err);
  });
});

describe("sync against SQLite (investor fixture)", () => {
  let db: Database.Database;
  let port: SqlPort;
  beforeEach(() => {
    ({ db, port } = sqlite());
    seed(db);
  });
  afterEach(() => db.close());

  it("links the same person across Data Room and Investor Review", async () => {
    const report = await syncManifest(async () => port, MANIFEST);
    const scottReview = await entityForRow(port, "investor_review", "o1", "Person");
    const scottPartner = await entityForRow(port, "vc_partners", "p1", "Person");
    expect(scottReview?.entityId).toBe(scottPartner?.entityId);
    const jane = await entityForRow(port, "investor_review", "o2", "Person");
    expect(jane?.entityId).toBe((await entityForRow(port, "vc_partners", "p2", "Person"))?.entityId);
    expect(report.sharedAcrossRows).toBeGreaterThanOrEqual(4);
  });

  it("links Norwest by domain even though names differ", async () => {
    await syncManifest(async () => port, MANIFEST);
    const fund = await entityForRow(port, "investors", "norwest", "Company");
    const reviewFund = await entityForRow(port, "investor_review", "o1", "Company");
    expect(reviewFund?.entityId).toBe(fund?.entityId);
    expect(fund?.facts).toMatchObject({ stage: "seed" });
    expect(fund?.rows.find((r) => r.table === "investors")?.legacy).toEqual({ attio_record_id: "att_1" });
  });

  it("never merges two Alex Kims with different emails, and reports the ambiguous review row", async () => {
    const report = await syncManifest(async () => port, MANIFEST);
    const a = await entityForRow(port, "vc_partners", "p3", "Person");
    const b = await entityForRow(port, "vc_partners", "p4", "Person");
    expect(a?.entityId).not.toBe(b?.entityId);
    expect(await entityForRow(port, "investor_review", "o3", "Person")).toBeNull();
    const personReview = report.bindings.find((x) => x.type === "Person" && x.table === "investor_review")!;
    expect(personReview.conflicts).toEqual([{ row: "o3", reason: expect.stringMatching(/ambiguous/) }]);
  });

  it("is idempotent: a second sync keeps ids and creates nothing", async () => {
    await syncManifest(async () => port, MANIFEST);
    const before = (await entityForRow(port, "vc_partners", "p1"))!.entityId;
    const again = await syncManifest(async () => port, MANIFEST);
    expect(again.bindings.every((b) => b.created === 0)).toBe(true);
    expect((await entityForRow(port, "vc_partners", "p1"))!.entityId).toBe(before);
  });

  it("only writes platform tables; app tables are untouched", async () => {
    const snapshot = () => db.prepare("SELECT * FROM investor_review ORDER BY outreach_id").all();
    const before = JSON.stringify(snapshot());
    await syncManifest(async () => port, MANIFEST);
    expect(JSON.stringify(snapshot())).toBe(before);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["_papr_entities", "_papr_entity_xref"]));
  });

  it("rows with no usable keys are recorded as unmatched", async () => {
    const report = await syncManifest(async () => port, MANIFEST);
    const inv = report.bindings.find((b) => b.table === "investors")!;
    expect(inv.unmatched + inv.created + inv.linked).toBe(3);
  });

  it("links rows that live in a different database than the identity home", async () => {
    const review = sqlite();
    review.db.exec(`CREATE TABLE investor_review (outreach_id TEXT PRIMARY KEY, full_name TEXT, email TEXT);
      INSERT INTO investor_review VALUES ('r1', 'Scott Beechuk', 'SCOTT@nvp.com'), ('r2', 'Nobody Known', NULL);`);
    const cross = validateManifest({
      version: 1, pack: "papr/fundraising@^1", home: "dataroom",
      uses: { Person: [
        { source: "review", table: "investor_review", key: "outreach_id", match: { email: "email", name: "full_name" } },
        { source: "dataroom", table: "vc_partners", key: "id", match: { email: "email", name: "name" } },
      ] },
    });
    const ports: Record<string, SqlPort> = { dataroom: port, review: review.port };
    const rep = await syncManifest(async (a) => ports[a]!, cross);
    // strong-key table ran first regardless of declaration order
    expect(rep.bindings[0]!.table).toBe("investor_review");
    expect((await entityForRow(port, "investor_review", "r1"))?.entityId).toBe((await entityForRow(port, "vc_partners", "p1"))?.entityId);
    // identity tables only in home, never in the review DB
    const reviewTables = (review.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(reviewTables).toEqual(["investor_review"]);
    review.db.close();
  });

  it("resolve and get", async () => {
    await syncManifest(async () => port, MANIFEST);
    const r = await resolveKeys(port, "Person", { email: "scott@nvp.com" });
    expect(r.via).toBe("email");
    const e = await getEntity(port, r.entityId!);
    expect(e?.rows.map((x) => x.table).sort()).toEqual(["investor_review", "vc_partners"]);
    expect(e?.facts).toMatchObject({ title: "Partner" });
  });
});

describe("observe", () => {
  let db: Database.Database;
  let port: SqlPort;
  beforeEach(async () => {
    ({ db, port } = sqlite());
    seed(db);
    await syncManifest(async () => port, MANIFEST);
  });
  afterEach(() => db.close());

  it("shadow mode resolves but never writes to the graph", async () => {
    const calls: unknown[] = [];
    const graph: GraphPort = { observe: async (x) => (calls.push(x), { memoryId: "m1" }) };
    const out = await observe(port, MANIFEST, { about: [{ type: "Person", match: { email: "scott@nvp.com" } }], text: "Met Scott" }, graph);
    expect(out.mode).toBe("shadow");
    expect(out.memoryId).toBeNull();
    expect(calls).toHaveLength(0);
    expect(out.resolved[0]).toMatchObject({ via: "email" });
    expect(out.wouldWrite).toMatchObject({ text: "Met Scott" });
  });

  it("live mode writes once and stamps synced_at", async () => {
    const live = { ...MANIFEST, mode: "live" as const };
    const calls: Array<Parameters<GraphPort["observe"]>[0]> = [];
    const graph: GraphPort = { observe: async (x) => (calls.push(x), { memoryId: "m1" }) };
    const out = await observe(port, live, { about: [{ type: "Person", match: { email: "scott@nvp.com" } }, { type: "Meeting", match: { meeting_key: "2026-10-21 nvp" } }], text: "Met Scott" }, graph);
    expect(out.memoryId).toBe("m1");
    expect(calls).toHaveLength(1);
    const scott = await getEntity(port, out.resolved[0]!.entityId!);
    expect(scott?.syncedAt).toBeTruthy();
  });

  it("live mode refuses types the app did not declare", async () => {
    const live = { ...MANIFEST, mode: "live" as const };
    await expect(observe(port, live, { about: [{ type: "Commitment", match: { commitment_key: "x" } }], text: "x" }, { observe: async () => ({ memoryId: null }) })).rejects.toThrow(/does not declare Commitment/);
  });

  it("validates input", async () => {
    await expect(observe(port, MANIFEST, { about: [], text: "x" })).rejects.toBeInstanceOf(EntitiesError);
    await expect(observe(port, MANIFEST, { about: [{ type: "Person", entityId: "e" }] })).rejects.toThrow(/text or facts/);
  });
});

describe("graph memory payload", () => {
  it("pins identity with link_to on strong keys and tags provenance", () => {
    const body = buildObserveMemory(
      {
        about: [],
        text: "Met Scott at Norwest",
        facts: { stage: "followup" },
        source: { table: "meetings", row: "m_149" },
        entities: [
          { type: "Person", entityId: "e1", keys: { email: "scott@nvp.com", name: "scott beechuk" } },
          { type: "Company", entityId: "e2", keys: { domain: "nvp.com" } },
        ],
      },
      { appId: "app1", pack: "papr/fundraising@^1", schemaId: "s1" },
    ) as Record<string, any>;
    expect(body.link_to).toEqual({ "Person:email=scott@nvp.com": {}, "Company:domain=nvp.com": {} });
    expect(body.memory_policy).toEqual({ mode: "auto", schema_id: "s1" });
    expect(body.metadata.customMetadata).toMatchObject({ content_type: "papr_entity_observation", papr_source_row: "m_149", papr_entity_ids: "e1,e2" });
    expect(body.content).toContain("stage=followup");
  });

  it("skips link_to values that would break the DSL", () => {
    expect(linkToFor([{ type: "Person", keys: { email: "a=b@c.com" } }])).toEqual({});
  });
});

describe("routes", () => {
  let server: ReturnType<express.Express["listen"]> | null = null;
  afterEach(() => server?.close());

  async function start(manifest: unknown) {
    const { db, port } = sqlite();
    seed(db);
    const app = express();
    app.use(express.json());
    registerEntitiesRoutes(app, {
      resolveAppId: (req, appId) => {
        const id = appId ?? (req.headers["x-papr-app-id"] as string | undefined);
        return id ? { appId: id } : { error: "appId is required", status: 400 };
      },
      readManifest: async (appId) => (appId === "noapp" ? null : manifest),
      sqlPort: async (_appId, alias) => {
        if (alias !== "dataroom") throw Object.assign(new Error("not linked"), { status: 404 });
        return port;
      },
    });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-papr-app-id": "app1" }, body: JSON.stringify(body) });
    return { base, post };
  }

  it("sync -> get -> resolve -> observe (shadow)", async () => {
    const { post } = await start(MANIFEST);
    const sync = (await (await post("/api/entities/sync", {})).json()) as any;
    expect(sync.mode).toBe("shadow");
    expect(sync.home).toBe("dataroom");
    expect(sync.sharedAcrossRows).toBeGreaterThan(0);
    const got = (await (await post("/api/entities/get", { table: "investor_review", row: "o1", type: "Person" })).json()) as any;
    expect(got.entity.keys.email).toBe("scott@nvp.com");
    const res = (await (await post("/api/entities/resolve", { type: "Person", match: { email: "SCOTT@nvp.com" } })).json()) as any;
    expect(res.entityId).toBe(got.entity.entityId);
    const obs = (await (await post("/api/entities/observe", { about: [{ type: "Person", match: { email: "scott@nvp.com" } }], text: "hi" })).json()) as any;
    expect(obs.mode).toBe("shadow");
    expect(obs.memoryId).toBeNull();
  });

  it("404 when the app has no entities.json; 400 on bad manifest or bad type", async () => {
    const { post } = await start({ version: 9 });
    expect((await post("/api/entities/sync", { appId: "noapp" })).status).toBe(404);
    expect((await post("/api/entities/sync", {})).status).toBe(400);
    const ok = await start(MANIFEST);
    expect((await ok.post("/api/entities/resolve", { type: "Robot", match: { email: "a@b.com" } })).status).toBe(400);
    expect((await ok.post("/api/entities/get", { sourceId: "nope", entityId: "x" })).status).toBe(400);
    expect((await ok.post("/api/entities/get", {})).status).toBe(400);
  });

  it("manifest route returns the validated manifest", async () => {
    const { base } = await start(MANIFEST);
    const res = await fetch(base + "/api/entities/manifest", { headers: { "x-papr-app-id": "app1" } });
    expect(((await res.json()) as any).pack).toBe("papr/fundraising@^1");
  });
});

describe("keysFromRow", () => {
  it("uses the binding's columns", () => {
    const b = MANIFEST.uses.Company![0]!;
    expect(keysFromRow("Company", b, { fund_url: "https://www.nvp.com/", name: "Norwest Venture Partners" })).toEqual({ domain: "nvp.com", name: "norwest" });
  });
});
