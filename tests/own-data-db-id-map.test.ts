import { describe, expect, it } from "vitest";
import {
  inferOwnDataDbIdMap,
  invertDbIdMap,
  publisherMigrationsDir,
  remapDbIdsInContent,
} from "../src/gateway/services/cloudSync/ownDataDbIdMap.js";

const ds = (pairs: Array<[string, string]>) =>
  JSON.stringify({ sources: pairs.map(([dbId, alias]) => ({ id: `${dbId}:${alias}`, dbId, alias, dbPath: "" })) });

describe("own-data copy database ids", () => {
  const publisher = ds([["db-dc9c634e", "lab"], ["db-8ff81798", "scratch"]]);
  const local = ds([["db-ea27362f", "lab"], ["db-81b291c4", "scratch"]]);

  it("pairs publisher and copy databases by alias", () => {
    const map = inferOwnDataDbIdMap(local, publisher);
    expect(Object.fromEntries(map)).toEqual({ "db-dc9c634e": "db-ea27362f", "db-8ff81798": "db-81b291c4" });
  });

  it("an update keeps the copy on its own databases", () => {
    const toLocal = inferOwnDataDbIdMap(local, publisher);
    expect(remapDbIdsInContent(publisher, toLocal)).toBe(local);
  });

  it("a proposal carries the publisher's ids, not the copy's", () => {
    const toPublisher = invertDbIdMap(inferOwnDataDbIdMap(local, publisher));
    expect(remapDbIdsInContent(local, toPublisher)).toBe(publisher);
  });

  it("leaves unpaired databases (a new one the copy added) and longer tokens alone", () => {
    const withNew = ds([["db-ea27362f", "lab"], ["db-12345678", "notes"]]);
    const map = invertDbIdMap(inferOwnDataDbIdMap(withNew, publisher));
    const out = remapDbIdsInContent(`${withNew} db-ea27362fff`, map);
    expect(out).toContain("db-12345678");
    expect(out).toContain("db-dc9c634e");
    expect(out).toContain("db-ea27362fff");
  });

  it("same ids (team copy) → empty map", () => {
    expect(inferOwnDataDbIdMap(publisher, publisher).size).toBe(0);
  });

  it("maps a de-duplicated fork migrations folder back to the publisher's", () => {
    const toPublisher = new Map([["db-2d301c32", "db-dc9c634e"]]);
    expect(publisherMigrationsDir("databases/spike-lab-2-2d301c32/migrations", toPublisher)).toBe(
      "databases/spike-lab-2/migrations",
    );
    expect(publisherMigrationsDir("databases/spike-lab-2/migrations", toPublisher)).toBe(
      "databases/spike-lab-2/migrations",
    );
  });
});
