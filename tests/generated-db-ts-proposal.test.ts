import { describe, expect, it } from "vitest";

import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import { isProposalExcludedAppPath } from "../src/gateway/services/cloudSync/contributeProposalPaths.js";
import { dataSourcesForProposal } from "../src/gateway/services/cloudSync/proposalFileMerge.js";
import { isCollaboratorEditablePath } from "../src/gateway/services/CloudAppTrackSyncService.js";

describe("db.ts is generated, never proposed", () => {
  it("is excluded from proposals and is not a collaborator-editable path", () => {
    expect(isProposalExcludedAppPath("db.ts")).toBe(true);
    expect(isCollaboratorEditablePath("db.ts")).toBe(false);
    // a nested file with the same name is real code
    expect(isProposalExcludedAppPath("utils/db.ts")).toBe(false);
  });

  it("a locally regenerated db.ts never reaches the change set", () => {
    const cs = buildProposalChangeSet([
      {
        repoDir: ".",
        kind: "app",
        base: new Map([["db.ts", "const APP_ID = 'owner';"]]),
        local: new Map([
          ["db.ts", "const APP_ID = 'copy';\nexport const DB_SOURCES = [\"gtm\",\"a7165fa7\"] as const;"],
          ["utils/db.ts", "export const real = 1;"],
        ]),
      },
    ]);
    expect([...cs.writes.keys()]).toEqual(["utils/db.ts"]);
  });
});

describe("proposals never carry job-database links", () => {
  const base = JSON.stringify({ sources: [{ id: "gtm", dbId: "db-1", alias: "gtm", dbPath: "" }] });

  it("drops job-scratch sources but keeps newly linked registry databases", () => {
    const local = JSON.stringify({
      sources: [
        { id: "gtm", dbId: "db-1", alias: "gtm", dbPath: "/x" },
        { id: "a7165fa7", jobId: "a7165fa7-job", alias: "a7165fa7", dbPath: "" },
        { id: "db-2:prep", dbId: "db-2", alias: "prep", dbPath: "/y" },
      ],
    });
    const out = JSON.parse(dataSourcesForProposal(base, local)!);
    expect(out.sources.map((s: { alias: string }) => s.alias)).toEqual(["gtm", "prep"]);
  });

  it("returns null when the only new links are job databases", () => {
    const local = JSON.stringify({
      sources: [
        { id: "gtm", dbId: "db-1", alias: "gtm", dbPath: "" },
        { id: "j1", jobId: "j1", alias: "j1", dbPath: "" },
      ],
    });
    expect(dataSourcesForProposal(base, local)).toBeNull();
  });
});
