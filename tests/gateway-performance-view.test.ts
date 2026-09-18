import { expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("report displays host pressure, unavailable metrics and stack text safely", async () => {
  const html = await readFile(new URL("../src/resources/gateway-performance-view.html", import.meta.url), "utf8");
  const now = new Date().toISOString();
  const available = (value: unknown) => ({ status: "available", value });
  const sample = { finishedAt: now, memoryPressure: available({ level: "warning" }),
    swap: available({ usedBytes: 1024 ** 3 }), virtualMemory: available({ compressorBytes: 2 * 1024 ** 3 }),
    vmCounterRatesPerSecond: { swapins: 10, swapouts: 20 }, loadAverage: [4], logicalCpuCount: 8,
    processes: { status: "unavailable", reason: "EPERM" } };
  const connection = { databasePath: "/tmp/app/data.db", owner: "cloudAppMeta", connectionId: "connection-1", pid: 100, threadId: 0,
    transaction: { state: "none" }, operations: [{ kind: "prepare:read" }] };
  const payload = { capturedAt: now, resources: { watchdog: { status: "running", snapshotAgeMs: 100,
    snapshot: { databases: { status: "listening", droppedRecords: 0, connections: [connection] }, samples: [sample], observerGaps: [], stalls: [{ detectedAt: now, heartbeatAgeMs: 3000,
      nativeDatabaseLockWait: true, databaseEvidence: { waitingCandidates: [{ waiting: connection, suspectedCompetingConnections: [] }] }, stack: available({ text: 'Call graph: <img src=x onerror="alert(1)"> readSync', truncated: false }) }] } } },
    timeline: { operations: [], slowEventLoopWindows: [] } };
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(window) {
    window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    window.HTMLCanvasElement.prototype.getContext = (() => ({ fillText() {} })) as never;
  } });
  try {
    await vi.waitFor(() => expect(dom.window.document.querySelector("#hostTable tbody")?.textContent).toContain("warning"));
    expect(dom.window.document.querySelector("#hostTable tbody")?.textContent).toContain("1.00 GiB");
    expect(dom.window.document.querySelector("#hostTable tbody")?.textContent).toContain("10.0 / 20.0");
    expect(dom.window.document.querySelector("#processMetrics")?.textContent).toContain("EPERM");
    expect(dom.window.document.querySelector("#stackCaptures")?.textContent).toContain("readSync");
    expect(dom.window.document.querySelector("#databaseActivity")?.textContent).toContain("cloudAppMeta");
    expect(dom.window.document.querySelector("#stackCaptures")?.textContent).toContain("unknown / none observed");
    expect(dom.window.document.querySelectorAll("#stackCaptures img")).toHaveLength(0);
  } finally { dom.window.close(); }
});

test("waterfall aligns waits, failures and samples and supports inspection and filtering", async () => {
  const html = await readFile(new URL("../src/resources/gateway-performance-view.html", import.meta.url), "utf8");
  const time = (n: number) => new Date(Date.UTC(2026, 8, 17, 20, 0, n)).toISOString();
  const payload = { capturedAt: time(10), timeline: { rangeStart: time(0), operations: [
    { id: "chat", kind: "chat", name: "Chat one", queuedAt: time(0), startedAt: time(0), finishedAt: time(10), status: "completed" },
    { id: "tool", turnId: "chat", kind: "tool", name: "<img src=x>read_file", queuedAt: time(2), startedAt: time(2), finishedAt: time(8), status: "completed", waits: [{ startedAt: time(3), finishedAt: time(5) }] },
    { id: "queued", kind: "background", name: "Waiting", queuedAt: time(4), status: "queued" },
  ], healthEvents: [{ id: "failure", timestamp: time(6), status: "failed", reason: "timeout" }] }, resources: { samples: [
    { startedAt: time(0), finishedAt: time(2), eventLoop: { maxMs: 50 } },
    { startedAt: time(2), finishedAt: time(10), eventLoop: { maxMs: 8000 } },
  ] } };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) { w.fetch = fetch; } });
  try {
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.querySelectorAll("[data-operation-id]")).toHaveLength(3));
    expect(doc.querySelector("main > section")?.id).toBe("timelineSection");
    const wait = doc.querySelector<HTMLElement>('[data-operation-id="tool"] .wait')!;
    expect(wait.style.left).toBe("30%"); expect(wait.style.width).toBe("20%");
    expect(doc.querySelectorAll('[data-operation-id="queued"] .bar:not(.wait)')).toHaveLength(0);
    expect(doc.querySelector<HTMLElement>(".marker")?.style.left).toBe("60%");
    const bar = doc.querySelector<HTMLElement>('[data-operation-id="tool"] .bar')!;
    bar.click(); expect(doc.querySelector("#inspector")?.textContent).toContain("Chat one");
    expect(doc.querySelector('[data-operation-id="chat"]')?.classList.contains("related")).toBe(true);
    expect(doc.querySelectorAll("#timeline img, #inspector img")).toHaveLength(0);
    const legend = [...doc.querySelectorAll<HTMLElement>("#legend span")].find(e => e.textContent === "Tool")!;
    expect((legend.firstChild as HTMLElement).style.backgroundColor).toBe(bar.style.backgroundColor);
    doc.querySelector<HTMLElement>(".marker button")!.click();
    expect(doc.querySelector("#inspector")?.textContent).toContain("Health check failed");
    expect(doc.querySelector("#inspector")?.textContent).toContain("3 recorded operations");
    const search = doc.querySelector<HTMLInputElement>("#search")!; search.value = "Waiting";
    search.dispatchEvent(new dom.window.Event("input"));
    expect(doc.querySelectorAll("[data-operation-id]")).toHaveLength(1);
    expect(doc.querySelectorAll(".marker")).toHaveLength(1);
  } finally { dom.window.close(); }
});


test("renderer delays share the timeline and missing acknowledgements stay unknown", async () => {
  const html = await readFile(new URL("../src/resources/gateway-performance-view.html", import.meta.url), "utf8");
  const startedAt = "2026-09-18T00:00:00.000Z", finishedAt = "2026-09-18T00:00:05.000Z";
  const payload = { capturedAt: finishedAt, timeline: { operations: [] }, renderer: { note: "Not per-app CPU attribution", sessions: [
    { sessionId: "renderer-1", ageMs: 20000, stale: true, samples: [{ sequence: 1, startedAt, finishedAt,
      documentVisible: true, longTasksSupported: true, inputTimingSupported: false, longTaskCount: 1,
      longTaskTotalMs: 120, maxTimerDelayMs: 0, failedReports: 0, droppedIncidents: 0,
      apps: [{ appId: "<img src=x>", loaded: true, expectedPhase: "hidden", acknowledgedPhase: null,
        acknowledgementAgeMs: null, gate: null }],
      incidents: [{ kind: "long-task", startedAt, durationMs: 120 }] }] }
  ] } };
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", beforeParse(w) {
    w.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  } });
  try {
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.querySelector("#rendererActivity")?.textContent).toContain("STALE"));
    expect(doc.querySelector("#rendererActivity")?.textContent).toContain("unknown");
    expect(doc.querySelector("#rendererActivity")?.textContent).toContain("unsupported");
    expect(doc.querySelectorAll("#rendererActivity img")).toHaveLength(0);
    expect(doc.querySelector('[data-operation-id="renderer:renderer-1:1:0"]')).not.toBeNull();
  } finally { dom.window.close(); }
});
