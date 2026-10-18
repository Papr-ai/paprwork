import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { JobEventHub } from "./JobEventHub.js";
import { registerJobEventsSseRoutes, type JobStatusPollResult } from "./registerJobEventsSse.js";
import { dispatchPushedJobEvent } from "./appRuntime/jobEventsPubSubSubscriber.js";

interface Harness {
  hub: JobEventHub;
  url: string;
  polls: string[];
  close: () => Promise<void>;
}

async function start(opts: {
  pushActive: boolean;
  snapshot: (jobId: string) => JobStatusPollResult | null;
  pollIntervalMs?: number;
  safetyPollMs?: number;
}): Promise<Harness> {
  const hub = new JobEventHub();
  const polls: string[] = [];
  const app = express();
  registerJobEventsSseRoutes(app, {
    hub,
    pushActive: () => opts.pushActive,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    safetyPollMs: opts.safetyPollMs ?? 60_000,
    pollJobStatus: async (jobId) => {
      polls.push(jobId);
      return opts.snapshot(jobId);
    },
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    hub,
    polls,
    url: `http://127.0.0.1:${port}/api/jobs/events`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Minimal SSE reader: collects jobs:* events until aborted. */
function listen(url: string): { events: Array<{ type: string; data: Record<string, unknown> }>; stop: () => void } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const ctrl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, stop: () => ctrl.abort() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const push = (hub: JobEventHub, ownerKey: string, data: Record<string, unknown>, recordedAt?: string) =>
  dispatchPushedJobEvent(hub, JSON.stringify({ type: "jobs:status-changed", ownerKey, recordedAt, data }));

describe("job events SSE with pushed status", () => {
  let h: Harness | undefined;
  beforeEach(() => vi.useRealTimers());
  afterEach(async () => { await h?.close(); h = undefined; });

  it("reads once on connect, then stops polling idle jobs and forwards pushed events", async () => {
    h = await start({ pushActive: true, snapshot: (id) => ({ jobId: id, status: "completed", ownerKey: "owner-A" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(400); // ~8 poll ticks
    expect(h.polls).toEqual(["j1"]); // one baseline read, no 5s loop

    push(h.hub, "owner-A", { jobId: "j1", status: "running" }, "2026-01-01T00:00:01Z");
    push(h.hub, "owner-A", { jobId: "j1", status: "completed", completedAt: "t2", lastOutput: "ok" }, "2026-01-01T00:00:02Z");
    await sleep(100);
    s.stop();
    expect(s.events.map((e) => e.data.status)).toEqual(["running", "completed"]);
    expect(s.events[1].data.lastOutput).toBe("ok");
    expect(JSON.stringify(s.events)).not.toContain("owner-A"); // ownerKey never reaches the browser
  });

  it("never forwards another owner's event (per-user apps)", async () => {
    h = await start({ pushActive: true, snapshot: (id) => ({ jobId: id, status: "completed", ownerKey: "owner-A" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(100);
    push(h.hub, "owner-B", { jobId: "j1", status: "running", lastOutput: "secret" });
    await sleep(100);
    s.stop();
    expect(s.events).toEqual([]);
  });

  it("drops duplicates and out-of-order deliveries", async () => {
    h = await start({ pushActive: true, snapshot: (id) => ({ jobId: id, status: "pending", ownerKey: "o" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(100);
    push(h.hub, "o", { jobId: "j1", status: "completed", completedAt: "t2" }, "2026-01-01T00:00:05Z");
    push(h.hub, "o", { jobId: "j1", status: "completed", completedAt: "t2" }, "2026-01-01T00:00:05Z");
    push(h.hub, "o", { jobId: "j1", status: "running" }, "2026-01-01T00:00:03Z"); // late
    await sleep(100);
    s.stop();
    expect(s.events.map((e) => e.data.status)).toEqual(["completed"]);
  });

  it("safety re-read only while a job is running", async () => {
    let status = "running";
    h = await start({
      pushActive: true,
      safetyPollMs: 150,
      snapshot: (id) => ({ jobId: id, status, ownerKey: "o" }),
    });
    const s = listen(`${h.url}?jobIds=j1,j2`);
    await sleep(100);
    status = "completed"; // event lost: the safety read must catch it
    await sleep(300);
    const afterCatch = h.polls.length;
    await sleep(400); // both idle now → no more reads
    s.stop();
    expect(s.events.map((e) => e.data.status)).toContain("completed");
    expect(h.polls.length).toBe(afterCatch);
  });

  it("keeps polling when push is not active (desktop / subscriber down / old memory)", async () => {
    h = await start({ pushActive: false, snapshot: (id) => ({ jobId: id, status: "completed", ownerKey: "o" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(300);
    s.stop();
    expect(h.polls.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps polling when memory does not return ownerKey yet (deploy order safety)", async () => {
    h = await start({ pushActive: true, snapshot: (id) => ({ jobId: id, status: "completed" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(300);
    s.stop();
    expect(h.polls.length).toBeGreaterThanOrEqual(4);
  });

  it("in-process status events (runs started on this host) still pass through", async () => {
    h = await start({ pushActive: true, snapshot: (id) => ({ jobId: id, status: "completed", ownerKey: "o" }) });
    const s = listen(`${h.url}?jobIds=j1`);
    await sleep(100);
    h.hub.publish({ type: "jobs:status-changed", data: { jobId: "j1", status: "running" } });
    await sleep(100);
    s.stop();
    expect(s.events.map((e) => e.data.status)).toEqual(["running"]);
  });
});

describe("dispatchPushedJobEvent", () => {
  it("rejects malformed and owner-less status events", () => {
    const hub = new JobEventHub();
    const seen: unknown[] = [];
    hub.subscribe((e) => seen.push(e));
    expect(dispatchPushedJobEvent(hub, "not json")).toBe(false);
    expect(dispatchPushedJobEvent(hub, JSON.stringify({ type: "jobs:status-changed", data: { jobId: "j", status: "x" } }))).toBe(false);
    expect(dispatchPushedJobEvent(hub, JSON.stringify({ type: "other", ownerKey: "o", data: {} }))).toBe(false);
    expect(seen).toEqual([]);
  });
});
