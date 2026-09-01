import { afterEach, describe, expect, it, vi } from "vitest";

describe("drainTursoReplicaConnections", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    const { resetTursoReplicaServiceForTests } = await import(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js"
    );
    resetTursoReplicaServiceForTests();
  });

  it("is a no-op when no replica service instance exists", async () => {
    const { drainTursoReplicaConnections, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    await expect(drainTursoReplicaConnections("test")).resolves.toBeUndefined();
  });

  it("closes all open handles when the service has connections", async () => {
    const {
      drainTursoReplicaConnections,
      getTursoReplicaService,
      resetTursoReplicaServiceForTests,
    } = await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");

    resetTursoReplicaServiceForTests();
    const service = getTursoReplicaService();
    const closeAll = vi.spyOn(service, "closeAll").mockResolvedValue(undefined);
    vi.spyOn(service, "getOpenConnectionCount").mockReturnValue(3);

    await drainTursoReplicaConnections("workspace switch");

    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("skips closeAll when open connection count is zero", async () => {
    const {
      drainTursoReplicaConnections,
      getTursoReplicaService,
      resetTursoReplicaServiceForTests,
    } = await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");

    resetTursoReplicaServiceForTests();
    const service = getTursoReplicaService();
    const closeAll = vi.spyOn(service, "closeAll").mockResolvedValue(undefined);
    vi.spyOn(service, "getOpenConnectionCount").mockReturnValue(0);

    await drainTursoReplicaConnections("gateway shutdown");

    expect(closeAll).not.toHaveBeenCalled();
  });
});
