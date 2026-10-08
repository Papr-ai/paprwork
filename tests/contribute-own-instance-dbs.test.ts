import { describe, expect, it } from "vitest";
import { isProposalExcludedAppPath } from "../src/gateway/services/cloudSync/contributeProposalPaths.js";
import {
  ownInstanceDbIds,
  stripDbIdsFromProposalFile,
} from "../src/gateway/services/cloudSync/ownDataDbIdMap.js";

const pub = JSON.stringify({
  sources: [
    { id: "db-aaaaaaaa:lab", dbId: "db-aaaaaaaa", alias: "lab" },
    { id: "db-bbbbbbbb:scratch", dbId: "db-bbbbbbbb", alias: "scratch" },
  ],
});
// A copy on its own data that still has the publisher's ids linked too.
const mine = JSON.stringify({
  sources: [
    { id: "db-11111111:lab", dbId: "db-11111111", alias: "lab" },
    { id: "db-22222222:scratch", dbId: "db-22222222", alias: "scratch" },
    { id: "db-aaaaaaaa:lab", dbId: "db-aaaaaaaa", alias: "lab" },
    { id: "db-bbbbbbbb:scratch", dbId: "db-bbbbbbbb", alias: "scratch" },
    { id: "db-99999999:extra", dbId: "db-99999999", alias: "extra" },
  ],
});

describe("own-instance databases in proposals", () => {
  it("finds the copy's own instances by alias, not genuinely new databases", () => {
    expect([...ownInstanceDbIds(mine, pub)].sort()).toEqual(["db-11111111", "db-22222222"]);
  });

  it("strips them from data-sources and linked-databases", () => {
    const ids = ownInstanceDbIds(mine, pub);
    const ds = JSON.parse(stripDbIdsFromProposalFile("data-sources.json", mine, ids));
    expect(ds.sources.map((s: { dbId: string }) => s.dbId)).toEqual(["db-aaaaaaaa", "db-bbbbbbbb", "db-99999999"]);
    const linked = JSON.stringify({ version: 1, databases: { "db-11111111": {}, "db-aaaaaaaa": {}, "db-99999999": {} } });
    const out = JSON.parse(stripDbIdsFromProposalFile("linked-databases.json", linked, ids));
    expect(Object.keys(out.databases)).toEqual(["db-aaaaaaaa", "db-99999999"]);
  });

  it("never proposes the cloud revision marker", () => {
    expect(isProposalExcludedAppPath(".papr-cloud-revision")).toBe(true);
    expect(isProposalExcludedAppPath("data/cloud-repo-head.txt")).toBe(true);
  });
});
