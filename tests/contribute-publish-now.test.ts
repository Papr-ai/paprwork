/**
 * Roles plan: a Maintainer/Admin "Publish now" carries rebuilt build outputs,
 * because nobody on the publisher's side rebuilds them afterwards. A normal
 * proposal still leaves them out.
 */
import { describe, expect, it } from "vitest";

import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import { isBuildOutputAppPath } from "../src/gateway/services/cloudSync/contributeProposalPaths.js";

function appTree(includeBuildOutputs: boolean) {
  return {
    repoDir: ".",
    kind: "app" as const,
    local: new Map([
      ["app.ts", "const v = 2;"],
      ["dist/app.js", "var v = 2;"],
      ["backend/bundle.json", '{"v":2}'],
      ["__papr__/app-meta.json", '{"distRevision":"b"}'],
      ["metadata.json", '{"title":"mine"}'],
    ]),
    base: new Map([
      ["app.ts", "const v = 1;"],
      ["dist/app.js", "var v = 1;"],
      ["backend/bundle.json", '{"v":1}'],
      ["__papr__/app-meta.json", '{"distRevision":"a"}'],
      ["metadata.json", '{"title":"theirs"}'],
    ]),
    ...(includeBuildOutputs ? { includeBuildOutputs: true } : {}),
  };
}

describe("publish now build outputs", () => {
  it("a proposal leaves build outputs out", () => {
    const writes = [...buildProposalChangeSet([appTree(false)]).writes.keys()];
    expect(writes).toEqual(["app.ts"]);
  });

  it("a direct publish carries dist, backend bundle and app-meta, never metadata.json", () => {
    const writes = [...buildProposalChangeSet([appTree(true)]).writes.keys()].sort();
    expect(writes).toEqual(["__papr__/app-meta.json", "app.ts", "backend/bundle.json", "dist/app.js"]);
  });

  it("classifies build output paths", () => {
    expect(isBuildOutputAppPath("dist/app.js")).toBe(true);
    expect(isBuildOutputAppPath("backend/bundle.json")).toBe(true);
    expect(isBuildOutputAppPath("__papr__/app-meta.json")).toBe(true);
    expect(isBuildOutputAppPath("__papr__/platform-catalog.json")).toBe(false);
    expect(isBuildOutputAppPath("metadata.json")).toBe(false);
    expect(isBuildOutputAppPath("db.ts")).toBe(false);
  });
});
