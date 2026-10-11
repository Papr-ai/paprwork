/**
 * metadata.claude contract, backend action fields, and the publish-time card builder.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAppBackendManifest } from "../appRuntime/appBackendManifest.js";
import { buildAppCards, cardHtml, checkCardHtml, CARD_SOFT_LIMIT_BYTES } from "./cardBuild.js";
import { checkViewsAgainstBackend, parseClaudeAppConfig } from "./cardContract.js";

const MANIFEST = {
  version: 1,
  actions: {
    "pipeline-summary": { handler: "summary.py", runtime: "python", effect: "read" },
    "draft-message": {
      handler: "draft.py",
      runtime: "python",
      effect: "write",
      input: { type: "object", properties: { lead: { type: "string" }, tone: { type: "string", enum: ["warm", "direct"] } }, required: ["lead"] },
    },
    "send-messages": { handler: "send.py", runtime: "python", effect: "external", runsOn: "mac" },
  },
};

describe("backend action fields", () => {
  it("parses input, effect and runsOn", () => {
    const m = parseAppBackendManifest(MANIFEST);
    expect(m.actions["draft-message"].input?.required).toEqual(["lead"]);
    expect(m.actions["send-messages"]).toMatchObject({ effect: "external", runsOn: "mac" });
    expect(m.actions["pipeline-summary"].runsOn).toBeUndefined();
  });

  it.each([
    [{ effect: "delete" }, /effect must be/],
    [{ runsOn: "lambda" }, /runsOn must be/],
    [{ input: { type: "array" } }, /must be \{ "type": "object"/],
    [{ input: { type: "object", properties: { x: { type: "object" } } } }, /type must be string/],
    [{ input: { type: "object", properties: { x: { type: "string" } }, required: ["y"] } }, /required must list/],
  ])("rejects %j", (extra, msg) => {
    expect(() => parseAppBackendManifest({ version: 1, actions: { a: { handler: "a.py", runtime: "python", ...extra } } })).toThrow(msg);
  });
});

describe("metadata.claude", () => {
  it("is off unless enabled", () => {
    expect(parseClaudeAppConfig({ title: "x" })).toBeNull();
    expect(parseClaudeAppConfig({ claude: { enabled: false, views: { s: { kind: "status" } } } })).toBeNull();
  });

  it("parses default and custom views", () => {
    const cfg = parseClaudeAppConfig({
      claude: { enabled: true, summary: "Outreach", views: { status: { kind: "status", from: "pipeline-summary" }, inbox: { entry: "cards/inbox.ts", title: "Replies" } } },
    });
    expect(cfg?.views.inbox).toEqual({ entry: "cards/inbox.ts", title: "Replies" });
    expect(cfg?.summary).toBe("Outreach");
  });

  it.each([
    [{ Bad: { kind: "status", from: "x" } }, /name must be/],
    [{ s: { kind: "status" } }, /need "from"/],
    [{ s: { kind: "action" } }, /need "action"/],
    [{ s: { kind: "chart" } }, /kind must be/],
    [{ s: { entry: "../evil.ts" } }, /under cards\//],
    [{ s: { entry: "cards/a.ts", kind: "status", from: "x" } }, /not both/],
    [{ s: {} }, /needs "kind"/],
  ])("rejects views %j", (views, msg) => {
    expect(() => parseClaudeAppConfig({ claude: { enabled: true, views } })).toThrow(msg);
  });

  it("cross-checks views against backend actions", () => {
    const m = parseAppBackendManifest(MANIFEST);
    const cfg = parseClaudeAppConfig({
      claude: { enabled: true, views: { a: { kind: "status", from: "draft-message" }, b: { kind: "action", action: "nope" } } },
    })!;
    const errors = checkViewsAgainstBackend(cfg, m);
    expect(errors.join("\n")).toMatch(/"draft-message" must declare "effect": "read"/);
    expect(errors.join("\n")).toMatch(/"nope" not found/);
  });
});

describe("card HTML checks", () => {
  it("escapes script terminators inside bundled code", () => {
    const html = cardHtml("t", 'const s = "</script><script>alert(1)</script>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("flags external code and oversize cards", () => {
    expect(checkCardHtml("a", '<script src="https://cdn/x.js"></script>').errors[0]).toMatch(/external <script src>/);
    expect(checkCardHtml("a", "x".repeat(CARD_SOFT_LIMIT_BYTES + 1)).warnings[0]).toMatch(/load fastest/);
  });
});

describe("buildAppCards", () => {
  let appDir: string;
  beforeEach(async () => {
    appDir = await mkdtemp(path.join(os.tmpdir(), "papr-cards-"));
    await mkdir(path.join(appDir, "backend"), { recursive: true });
    await mkdir(path.join(appDir, "cards"), { recursive: true });
    await writeFile(path.join(appDir, "backend", "manifest.json"), JSON.stringify(MANIFEST));
  });
  afterEach(() => rm(appDir, { recursive: true, force: true }));

  const writeMeta = (claude: unknown) => writeFile(path.join(appDir, "metadata.json"), JSON.stringify({ title: "Outreach", claude }));

  it("builds single-file cards for default and custom views", async () => {
    await writeFile(
      path.join(appDir, "cards", "inbox.ts"),
      `import { card } from "/__papr__/papr-card.ts";
       card({ primary: { label: "Send", action: "send-messages", effect: "external" },
              async render({ body }) { const r = await fetch("/api/db/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }) }); body.textContent = String(r.status); } });`,
    );
    await writeMeta({
      enabled: true,
      summary: "Find warm leads",
      views: {
        status: { kind: "status", from: "pipeline-summary" },
        draft: { kind: "action", action: "draft-message" },
        send: { kind: "approval", action: "send-messages" },
        inbox: { entry: "cards/inbox.ts", title: "Replies" },
      },
    });
    const r = await buildAppCards(appDir);
    expect(r.errors).toEqual([]);
    expect(r.success).toBe(true);
    expect(r.cards.map((c) => c.view).sort()).toEqual(["draft", "inbox", "send", "status"]);

    for (const c of r.cards) {
      const html = await readFile(path.join(appDir, c.file), "utf8");
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toContain("/__papr__/");
      expect(html).toContain("ui/initialize");
      expect(c.bytes).toBeLessThan(CARD_SOFT_LIMIT_BYTES);
    }
    const draft = await readFile(path.join(appDir, "dist/cards/draft.html"), "utf8");
    expect(draft).toContain("draft-message");
    expect(draft).toContain('"warm"');

    const manifest = JSON.parse(await readFile(path.join(appDir, "dist/cards/cards.json"), "utf8"));
    expect(manifest.summary).toBe("Find warm leads");
    expect(manifest.views.inbox).toMatchObject({ entry: "cards/inbox.ts", title: "Replies", file: "inbox.html" });
  });

  it("reports author errors with file and line, and writes nothing", async () => {
    await writeFile(path.join(appDir, "cards", "broken.ts"), `import { nope } from "/__papr__/papr-missing.ts";\nnope();`);
    await writeMeta({ enabled: true, views: { broken: { entry: "cards/broken.ts" } } });
    const r = await buildAppCards(appDir);
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/card "broken": Unknown Papr SDK module \/__papr__\/papr-missing.ts/);
    expect(existsSync(path.join(appDir, "dist/cards"))).toBe(false);
  });

  it("removes stale cards when Claude is turned off", async () => {
    await writeMeta({ enabled: true, views: { status: { kind: "status", from: "pipeline-summary" } } });
    expect((await buildAppCards(appDir)).cards).toHaveLength(1);
    await writeMeta({ enabled: false });
    const r = await buildAppCards(appDir);
    expect(r.enabled).toBe(false);
    expect(existsSync(path.join(appDir, "dist/cards"))).toBe(false);
  });
});
