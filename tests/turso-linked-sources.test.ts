import { describe, expect, it } from "vitest";
import {
  findLinkedSourceForJob,
  linkedSourceAlternateKeys,
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "../src/gateway/services/tursoLinkedSources.js";

describe("tursoLinkedSources", () => {
  const registryLinked: TursoLinkedSource = {
    appId: "app-1",
    jobId: "a5b67ed7-2372-42af-bc39-59570f1455b9",
    dbId: "db-be748425",
    dbPath: "/tmp/fetch/data.db",
    alias: "Fetch Meetings",
    role: "primary",
  };

  it("uses dbId as canonical sync key when registry-linked", () => {
    expect(linkedSourceSyncKey(registryLinked)).toBe("db-be748425");
  });

  it("exposes job UUID as alternate sync key for registry databases", () => {
    expect(linkedSourceAlternateKeys(registryLinked)).toEqual([
      "a5b67ed7-2372-42af-bc39-59570f1455b9",
    ]);
  });

  it("findLinkedSourceForJob resolves dbId sync key from watcher/scheduler", () => {
    const sources = [registryLinked];
    expect(findLinkedSourceForJob(sources, "db-be748425")).toEqual(registryLinked);
    expect(findLinkedSourceForJob(sources, "a5b67ed7-2372-42af-bc39-59570f1455b9")).toEqual(
      registryLinked,
    );
  });

  it("does not match jobId-only lookup when sync key is dbId", () => {
    const sources = [registryLinked];
    expect(sources.find((s) => s.jobId === "db-be748425")).toBeUndefined();
    expect(findLinkedSourceForJob(sources, "db-be748425")).toBeDefined();
  });
});
