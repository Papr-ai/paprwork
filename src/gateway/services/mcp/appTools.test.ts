/**
 * PR 2: per-app tool planning, the Claude app catalog, validate_app card checks,
 * and keeping metadata.claude across registry rewrites.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carryAuthorOwnedMetadata, type CloudAppMetadataFile } from "../../../core/utils/cloudAppMetadata.js";
import { argsToParams, inputSchemaToZodShape, planAppTools, toolResultFor } from "./appTools.js";
import { buildAppCards } from "./cardBuild.js";
import { claudeCardIssues, locateCardError } from "./cardValidation.js";
import { clearCatalogCache, loadClaudeCatalog, parseCardsManifest, type ClaudeApp } from "./catalog.js";

const caller = { sessionToken: "r:s", userId: "u1", subject: "x" };

function app(slug: string, views: Record<string, object>, extra: Partial<ClaudeApp> = {}): ClaudeApp {
  const v = Object.fromEntries(Object.entries(views).map(([k, x]) => [k, { file: `${k}.html`, bytes: 1, ...x }]));
  return { appId: slug, namespaceId: "ns1", slug, cards: { version: 1, views: v }, ...extra };
}

describe("planAppTools", () => {
  it("names tools {slug}_{view} and keeps them unique across workspaces", () => {
    const a = app("crm", { status: { kind: "status", from: "s" } });
    const b = { ...app("crm", { status: { kind: "status", from: "s" } }), namespaceId: "ns2" };
    expect(planAppTools([a, b]).map((t) => t.name)).toEqual(["crm_status", "crm_status-2"]);
  });

  it("sanitizes names to Claude's tool-name charset and length", () => {
    const [t] = planAppTools([app("My_App.v2-" + "x".repeat(80), { "the-view": { kind: "status", from: "s" } })]);
    expect(t.name).toMatch(/^[a-z0-9_-]{1,64}$/);
    expect(t.name.endsWith("_the-view")).toBe(true);
  });

  it("never collides with Papr's own tools and stops at the cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => app(`a${i}`, { s: { kind: "status", from: "s" }, t: { kind: "status", from: "s" } }));
    expect(planAppTools(many, 10)).toHaveLength(10);
    const papr = planAppTools([app("papr", { api: { entry: "cards/api.ts" } })]);
    expect(papr[0].name).not.toBe("papr_api");
  });

  it("is deterministic", () => {
    const apps = [app("x", { a: { kind: "status", from: "s" } }), app("y", { b: { kind: "status", from: "s" } })];
    expect(planAppTools(apps).map((t) => t.name)).toEqual(planAppTools(apps).map((t) => t.name));
  });

  it("writes descriptions from the action, summary and title", () => {
    const a = app(
      "outreach",
      {
        draft: { kind: "action", action: "draft-message", actionSpec: { name: "draft-message", description: "Draft a reply." } },
        inbox: { entry: "cards/inbox.ts", title: "Replies", description: "Replies waiting for you" },
      },
      { name: "Outreach" },
    );
    const [draft, inbox] = planAppTools([a]);
    expect(draft.description).toMatch(/^Papr · Outreach\. Opens a card ready to draft a reply; /);
    expect(inbox.description).toBe("Papr · Outreach. Opens Replies as an interactive card. Replies waiting for you.");
    expect(inbox.title).toBe("Outreach · Replies");
  });
});

describe("tool inputs and results", () => {
  const input = {
    type: "object" as const,
    properties: { lead: { type: "string" as const, maxLength: 5 }, n: { type: "integer" as const }, ok: { type: "boolean" as const }, tone: { type: "string" as const, enum: ["a", "b"] } },
    required: ["lead"],
  };

  it("converts flat JSON Schema to zod, required only for approvals", () => {
    const strict = inputSchemaToZodShape(input, true);
    expect(strict.lead.safeParse(undefined).success).toBe(false);
    expect(strict.lead.safeParse("toolong").success).toBe(false);
    expect(strict.n.safeParse(1.5).success).toBe(false);
    expect(strict.tone.safeParse("c").success).toBe(false);
    const loose = inputSchemaToZodShape(input, false);
    expect(loose.lead.safeParse(undefined).success).toBe(true);
    expect(inputSchemaToZodShape(undefined, true)).toEqual({});
  });

  it("stringifies params for backend actions", () => {
    expect(argsToParams({ a: 1, b: true, c: null, d: "x" })).toEqual({ a: "1", b: "true", d: "x" });
  });

  it("status tools carry no data; action tools prefill", () => {
    const [status, act] = planAppTools([app("x", { s: { kind: "status", from: "r" }, a: { kind: "action", action: "w" } })]);
    expect(toolResultFor(status, {}, "https://apps.papr.ai").structuredContent).toMatchObject({ view: "s", data: {}, openUrl: "https://apps.papr.ai/ns1/x" });
    expect(toolResultFor(act, { lead: "Ada" }, "https://apps.papr.ai").structuredContent.data).toEqual({ lead: "Ada" });
  });
});

describe("catalog", () => {
  beforeEach(() => clearCatalogCache());

  it("treats cards.json as untrusted", () => {
    expect(parseCardsManifest(null)).toBeNull();
    expect(parseCardsManifest({ version: 2, views: {} })).toBeNull();
    const m = parseCardsManifest({
      version: 1,
      views: {
        ok: { kind: "status", file: "ok.html", title: "T".repeat(500) },
        "../x": { kind: "status", file: "../x.html" },
        wrongfile: { kind: "status", file: "other.html" },
        badkind: { kind: "delete", file: "badkind.html" },
      },
    });
    expect(Object.keys(m!.views)).toEqual(["ok"]);
    expect(m!.views.ok.title).toHaveLength(80);
  });

  it("keeps apps with cards, newest first, and survives one broken app", async () => {
    const deps = {
      listAccessibleApps: async () => [
        { appId: "1", namespaceId: "n", slug: "old", updatedAt: "2025-01-01" },
        { appId: "2", namespaceId: "n", slug: "broken", updatedAt: "2026-02-01" },
        { appId: "3", namespaceId: "n", slug: "new", updatedAt: "2026-03-01" },
        { appId: "4", namespaceId: "n", slug: "plain", updatedAt: "2026-01-01" },
      ],
      loadCardsManifest: async (_c: unknown, ref: { slug: string }) => {
        if (ref.slug === "broken") throw new Error("403");
        if (ref.slug === "plain") return null;
        return { version: 1, views: { s: { kind: "status", file: "s.html" } } };
      },
    };
    const apps = await loadClaudeCatalog(caller, deps);
    expect(apps.map((a) => a.slug)).toEqual(["new", "old"]);
    const capped = await loadClaudeCatalog({ ...caller, userId: "u2" }, deps, { maxApps: 1 });
    expect(capped.map((a) => a.slug)).toEqual(["new"]);
  });

  it("caches per user until the TTL", async () => {
    let calls = 0;
    let t = 0;
    const deps = { listAccessibleApps: async () => (calls++, []), loadCardsManifest: async () => null };
    const opts = { ttlMs: 1000, now: () => t };
    await loadClaudeCatalog(caller, deps, opts);
    await loadClaudeCatalog(caller, deps, opts);
    await loadClaudeCatalog({ ...caller, userId: "other" }, deps, opts);
    expect(calls).toBe(2);
    t = 1001;
    await loadClaudeCatalog(caller, deps, opts);
    expect(calls).toBe(3);
  });
});

describe("metadata.claude survives registry rewrites", () => {
  const next: CloudAppMetadataFile = { appId: "a", title: "New title", description: "d", updatedAt: "now" };

  it("carries the claude block from the file on disk", () => {
    const claude = { enabled: true, views: { s: { kind: "status", from: "r" } } };
    expect(carryAuthorOwnedMetadata(next, { title: "Old", claude })).toEqual({ ...next, claude });
  });

  it("ignores junk and missing files", () => {
    expect(carryAuthorOwnedMetadata(next, null)).toEqual(next);
    expect(carryAuthorOwnedMetadata(next, { claude: "yes" })).toEqual(next);
    expect(carryAuthorOwnedMetadata(next, { claude: [1] })).toEqual(next);
  });
});

describe("validate_app card checks", () => {
  let dir: string;
  const manifest = {
    version: 1,
    actions: {
      summary: { handler: "s.py", runtime: "python", effect: "read" },
      send: { handler: "x.py", runtime: "python", effect: "write" },
    },
  };
  async function setup(claude: unknown, man: unknown = manifest): Promise<void> {
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify({ appId: "a", title: "A", claude }));
    await mkdir(path.join(dir, "backend"), { recursive: true });
    await writeFile(path.join(dir, "backend", "manifest.json"), JSON.stringify(man));
  }
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "papr-cardval-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("is silent for apps that haven't opted in", async () => {
    await setup(undefined);
    expect(await claudeCardIssues(dir)).toEqual([]);
  });

  it("reports config errors against metadata.json", async () => {
    await setup({ enabled: true, views: { s: { kind: "status", from: "nope" } } });
    const issues = await claudeCardIssues(dir);
    expect(issues.some((i) => i.severity === "error" && i.file === "metadata.json" && /nope/.test(i.message))).toBe(true);
    expect(issues.every((i) => i.rule === "claude-cards")).toBe(true);
  });

  it("warns on approval without effect external, missing summary and missing descriptions", async () => {
    await setup({ enabled: true, views: { s: { kind: "status", from: "summary" }, go: { kind: "approval", action: "send" } } });
    const warnings = (await claudeCardIssues(dir)).filter((i) => i.severity === "warning").map((i) => i.message);
    expect(warnings.some((m) => /effect": "external"/.test(m))).toBe(true);
    expect(warnings.some((m) => /summary/.test(m))).toBe(true);
    expect(warnings.some((m) => /"description"/.test(m))).toBe(true);
  });

  it("locates errors in card source files", () => {
    expect(locateCardError('card "inbox": Unknown thing (cards/inbox.ts:3)', "/app")).toEqual({ file: "cards/inbox.ts", line: 3 });
    expect(locateCardError("metadata.claude.views.x: bad", "/app")).toEqual({ file: "metadata.json" });
  });
});

describe("cards.json carries the action spec", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "papr-cardspec-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("so the MCP server can build tool schemas without the manifest", async () => {
    const input = { type: "object", properties: { lead: { type: "string" } }, required: ["lead"] };
    await writeFile(
      path.join(dir, "metadata.json"),
      JSON.stringify({ appId: "a", title: "A", claude: { enabled: true, views: { draft: { kind: "action", action: "draft" } } } }),
    );
    await mkdir(path.join(dir, "backend"));
    await writeFile(
      path.join(dir, "backend", "manifest.json"),
      JSON.stringify({ version: 1, actions: { draft: { handler: "d.py", runtime: "python", description: "Draft a reply", effect: "write", input } } }),
    );
    const res = await buildAppCards(dir);
    expect(res.errors).toEqual([]);
    const cards = JSON.parse(await readFile(path.join(dir, "dist", "cards", "cards.json"), "utf8"));
    expect(cards.views.draft.actionSpec).toEqual({ name: "draft", description: "Draft a reply", effect: "write", input });
  });
});
