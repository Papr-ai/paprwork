import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAppDbTsContent } from "../src/gateway/services/appDataSources.js";
import {
  checkOwnAppIdLiterals,
  findOwnAppIdLines,
  OWN_APP_ID_RULE,
} from "../src/gateway/utils/ownAppIdLiteralLint.js";

const OWN = "a3f38315-6e63-436f-81aa-bc016c45a080";
const OTHER = "5bebcac4-0000-4000-8000-000000000000";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function app(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), "own-app-id-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe("generated db.ts carries no app id", () => {
  it("has no APP_ID and sends no appId", () => {
    const out = buildAppDbTsContent([{ alias: "decks" }]);
    expect(out).not.toMatch(/APP_ID|appId/);
    expect(out).toContain("JSON.stringify({ sourceId, sql, params })");
    expect(out).toContain('export const DB_SOURCES = ["decks"] as const;');
  });

  it("is identical for every copy (nothing to rewrite on install or propose)", () => {
    expect(buildAppDbTsContent([{ alias: "a" }])).toBe(buildAppDbTsContent([{ alias: "a" }]));
  });
});

describe("own app id literal lint", () => {
  it("flags the app's own id in code, with line numbers, case-insensitive", async () => {
    const root = await app({
      "people.ts": `import x from './y';\nconst APP_ID = '${OWN}';\n`,
      "index.html": `<meta name="papr-app-id" content="${OWN.toUpperCase()}">`,
      "job-assets/save.py": `APP_ID = os.environ.get("PAPR_APP_ID", "${OWN}")\n`,
    });
    const issues = await checkOwnAppIdLiterals(root, OWN);
    expect(issues.map((i) => `${i.file}:${i.line}`).sort()).toEqual([
      "index.html:1",
      "job-assets/save.py:1",
      "people.ts:2",
    ]);
    expect(issues.every((i) => i.severity === "error" && i.rule === OWN_APP_ID_RULE)).toBe(true);
  });

  it("ignores platform records, build output, deps and other apps' ids", async () => {
    const root = await app({
      "metadata.json": JSON.stringify({ appId: OWN }),
      "linked-databases.json": JSON.stringify({ schemaOwnerAppId: OWN }),
      "data-sources.json": JSON.stringify({ appId: OWN }),
      "content/reports/notes.md": `app ${OWN}`,
      "dist/app.js": `const a='${OWN}'`,
      "node_modules/x/index.js": `'${OWN}'`,
      "deps.ts": `const UPSTREAM = '${OTHER}';`,
      "db.ts": `const APP_ID = '${OWN}';`,
      "app.ts": "fetch('/api/db/query', { body: JSON.stringify({ sourceId: 'decks', sql }) });",
    });
    expect(await checkOwnAppIdLiterals(root, OWN)).toEqual([]);
  });

  it("matches job command text", () => {
    expect(findOwnAppIdLines(`python3 run.py --app ${OWN}`, OWN)).toEqual([1]);
    expect(findOwnAppIdLines("python3 run.py --app {{papr.app_id}}", OWN)).toEqual([]);
  });
});
