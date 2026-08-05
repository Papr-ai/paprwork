import { describe, expect, it } from "vitest";
import {
  linkedSourceSyncKey,
  resolveLinkedSourcesForTursoPush,
  resolveTursoDatabaseLabel,
  type TursoLinkedSource,
} from "../src/gateway/services/tursoLinkedSources.js";

const APP_ID = "ca1ab3b1-9fbf-4146-a55b-f090bffd566e";
const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function source(partial: Partial<TursoLinkedSource> & Pick<TursoLinkedSource, "alias">): TursoLinkedSource {
  return {
    appId: APP_ID,
    dbPath: `/tmp/${partial.alias}.db`,
    alias: partial.alias,
    ...partial,
  };
}

describe("resolveLinkedSourcesForTursoPush", () => {
  const sources = [
    source({ alias: "gtm-audit", dbId: "db-2d6b4294" }),
    source({ alias: "scratch", jobId: JOB_ID, role: "scratch" }),
  ];

  it("resolves appId + alias", () => {
    const matches = resolveLinkedSourcesForTursoPush(sources, {
      appId: APP_ID,
      alias: "gtm-audit",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.alias).toBe("gtm-audit");
  });

  it("resolves all sources for appId", () => {
    const matches = resolveLinkedSourcesForTursoPush(sources, { appId: APP_ID });
    expect(matches.map((entry) => entry.alias)).toEqual(["gtm-audit", "scratch"]);
  });

  it("throws when alias missing", () => {
    expect(() =>
      resolveLinkedSourcesForTursoPush(sources, {
        appId: APP_ID,
        alias: "missing",
      }),
    ).toThrow(/No linked database alias/);
  });
});

describe("linkedSourceSyncKey", () => {
  it("prefers dbId over jobId", () => {
    const key = linkedSourceSyncKey(
      source({ alias: "main", dbId: "db-abc", jobId: JOB_ID }),
    );
    expect(key).toBe("db-abc");
  });
});

describe("resolveTursoDatabaseLabel", () => {
  it("throws when source cannot be labeled", () => {
    expect(() =>
      resolveTursoDatabaseLabel(
        source({ alias: "orphan", dbPath: "/tmp/orphan.db" }),
      ),
    ).toThrow(/Could not resolve Turso database/);
  });
});
