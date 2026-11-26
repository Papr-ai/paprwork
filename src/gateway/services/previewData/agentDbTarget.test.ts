import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertLiveWriteConfirmed, resolveAgentDbTarget, type TargetDeps } from "./agentDbTarget.js";
import type { AppDataSource } from "../appDataSources.js";

const real: AppDataSource = { id: "s", type: "sqlite", dbId: "db1", alias: "notes", dbPath: "/team.db", tables: [], linkedAt: "" };
const pvSource = { ...real, dbId: undefined, dbPath: "/pv.db", previewCopy: true } as AppDataSource;

describe("agent DB target (preview vs live)", () => {
  let root: string;
  const deps = (o: { shared?: boolean; preview?: boolean } = {}): TargetDeps => ({
    isCollaboratorOnShared: () => o.shared ?? true,
    previewFor: async () => (o.preview ?? true ? pvSource : null),
    paprRoot: root,
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tgt-"));
    const a = path.join(root, "apps", "app1");
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(path.join(a, "data-sources.json"), JSON.stringify({ sources: [{ dbId: "db1" }] }));
    fs.writeFileSync(path.join(a, "metadata.json"), JSON.stringify({ title: "Team Tasks" }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("rule 1: with a preview, no silent default", async () => {
    await expect(resolveAgentDbTarget(real, {}, deps())).rejects.toThrow(/target: "preview"/);
  });

  it("rule 2: each side names itself", async () => {
    const pv = await resolveAgentDbTarget(real, { target: "preview" }, deps());
    expect(pv.source.dbPath).toBe("/pv.db");
    expect(pv.label).toMatch(/^preview of Team Tasks/);
    const lv = await resolveAgentDbTarget(real, { target: "live" }, deps());
    expect(lv.source).toBe(real);
    expect(lv.label).toBe("team's live data");
  });

  it("no preview: only Live, and asking for preview says so", async () => {
    expect((await resolveAgentDbTarget(real, {}, deps({ preview: false }))).target).toBe("live");
    await expect(resolveAgentDbTarget(real, { target: "preview" }, deps({ preview: false }))).rejects.toThrow(/only the team's live data/);
    expect((await resolveAgentDbTarget(real, {}, deps({ shared: false }))).label).toMatch(/no preview/);
  });

  it("rule 4: a teammate's Live write needs the user's yes; preview and owners don't", async () => {
    const lv = await resolveAgentDbTarget(real, { target: "live" }, deps());
    expect(() => assertLiveWriteConfirmed(lv, false, "UPDATE notes SET x=1")).toThrow(/Ask the user first/);
    expect(() => assertLiveWriteConfirmed(lv, true, "UPDATE notes SET x=1")).not.toThrow();
    const pv = await resolveAgentDbTarget(real, { target: "preview" }, deps());
    expect(() => assertLiveWriteConfirmed(pv, false, "INSERT INTO notes DEFAULT VALUES")).not.toThrow();
    const owner = await resolveAgentDbTarget(real, {}, deps({ shared: false }));
    expect(() => assertLiveWriteConfirmed(owner, false, "DELETE FROM notes")).not.toThrow();
  });
});
