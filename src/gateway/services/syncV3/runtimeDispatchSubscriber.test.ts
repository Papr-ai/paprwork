import { describe, expect, it } from "vitest";
import { parseSseDataBlock } from "./runtimeDispatchSubscriber.js";
import { pullDbChangesWithRetry } from "../cloudSync/cloudSyncHeartbeat.js";

describe("parseSseDataBlock", () => {
  it("reads a db_changed event from memory", () => {
    const m = parseSseDataBlock('data: {"type":"db_changed","shortName":"release","dbId":"db-7d873f7a","tables":["prs"]}');
    expect(m).toEqual({ kind: "db_changed", event: { shortName: "release", dbId: "db-7d873f7a", jobId: undefined, tables: ["prs"] } });
  });
  it("still reads job runtime patches", () => {
    const m = parseSseDataBlock('data: {"type":"job_runtime_patch","patch":{"jobId":"j1"}}');
    expect(m).toEqual({ kind: "patch", patch: { jobId: "j1" } });
  });
  it("ignores keepalives, unknown types and db_changed without a name", () => {
    expect(parseSseDataBlock(": keepalive")).toBeNull();
    expect(parseSseDataBlock('data: {"type":"other"}')).toBeNull();
    expect(parseSseDataBlock('data: {"type":"db_changed"}')).toBeNull();
  });
});

describe("pullDbChangesWithRetry", () => {
  const noSleep = async () => undefined;
  const result = (pulled: number, failed = 0) => ({ pulled, pushed: 0, failed });

  it("pulls once when the change is already there", async () => {
    let calls = 0;
    const r = await pullDbChangesWithRetry([{ dbId: "d" }], async () => (calls++, result(1)), [250, 1000], noSleep);
    expect(r).toEqual({ pulled: 1, pushed: 0, attempts: 1 });
  });

  it("retries an empty pull until the replica catches up", async () => {
    const seq = [result(0), result(0), result(1)];
    const waited: number[] = [];
    const r = await pullDbChangesWithRetry([{ dbId: "d" }], async () => seq.shift()!, [250, 1000, 3000], async (ms) => { waited.push(ms); });
    expect(r.attempts).toBe(3);
    expect(r.pulled).toBe(1);
    expect(waited).toEqual([250, 1000]);
  });

  it("gives up after the last wait and leaves it to the heartbeat", async () => {
    let calls = 0;
    const r = await pullDbChangesWithRetry([{ dbId: "d" }], async () => (calls++, result(0)), [250, 1000, 3000], noSleep);
    expect(calls).toBe(4);
    expect(r.pulled).toBe(0);
  });

  it("does not retry a real failure", async () => {
    let calls = 0;
    await pullDbChangesWithRetry([{ dbId: "d" }], async () => (calls++, result(0, 1)), [250], noSleep);
    expect(calls).toBe(1);
  });
});
