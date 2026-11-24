import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("../../src/lib/gateway", () => ({ gateway: { send: (...a: unknown[]) => send(...a) } }));

import { initJobLiveLogsListener, useJobLiveLogsStore } from "../../stores/jobLiveLogsStore";

const broadcast = (type: string, data: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent("gateway-broadcast", { detail: { type, data } }));

describe("jobLiveLogsStore final status (#534)", () => {
  beforeEach(() => {
    send.mockReset();
    useJobLiveLogsStore.setState({ finalStatusByJobId: new Map() });
  });

  it("records final status from jobs:status-changed and clears it when a new run starts", () => {
    initJobLiveLogsListener();
    broadcast("jobs:status-changed", { jobId: "j1", status: "failed" });
    expect(useJobLiveLogsStore.getState().finalStatusByJobId.get("j1")).toBe("failed");
    broadcast("jobs:status-changed", { jobId: "j1", status: "running" });
    expect(useJobLiveLogsStore.getState().finalStatusByJobId.has("j1")).toBe(false);
  });

  it("reconcileStatus asks the gateway once and keeps only final statuses", async () => {
    send.mockResolvedValueOnce({ data: { status: "completed" } });
    await useJobLiveLogsStore.getState().reconcileStatus("j2");
    await useJobLiveLogsStore.getState().reconcileStatus("j2");
    expect(send).toHaveBeenCalledTimes(1);
    expect(useJobLiveLogsStore.getState().finalStatusByJobId.get("j2")).toBe("completed");

    send.mockResolvedValueOnce({ data: { status: "running" } });
    await useJobLiveLogsStore.getState().reconcileStatus("j3");
    expect(useJobLiveLogsStore.getState().finalStatusByJobId.has("j3")).toBe(false);
  });

  it("retries reconcile after a transient gateway error", async () => {
    send.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce({ data: { status: "failed" } });
    await useJobLiveLogsStore.getState().reconcileStatus("j4");
    await useJobLiveLogsStore.getState().reconcileStatus("j4");
    expect(useJobLiveLogsStore.getState().finalStatusByJobId.get("j4")).toBe("failed");
  });
});
