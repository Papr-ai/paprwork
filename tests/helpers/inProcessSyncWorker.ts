import * as path from "node:path";
import { vi } from "vitest";

const SRC = path.resolve(__dirname, "../../src/gateway/services/tursoReplica");
const CLIENT_MODULE = path.join(SRC, "TursoReplicaSyncWorkerClient.ts");
const CORE_MODULE = path.join(SRC, "tursoReplicaSyncWorkerCore.ts");
const WEDGE_MODULE = path.join(SRC, "tursoReplicaSidecarWedge.ts");

/**
 * Replace the child-process worker client with one that runs the worker core in-process.
 *
 * Tests that mock `@tursodatabase/sync` can then assert engine-level behaviour (pull before
 * push, checkpoint recovery, sidecar reset) exactly as before the engine moved out of the
 * gateway. Must be called after `vi.doMock("@tursodatabase/sync", ...)` and before the
 * service is imported.
 */
export function installInProcessSyncWorker(): void {
  vi.doMock(CLIENT_MODULE, async () => {
      const { TursoSyncWorkerCore } = await import(CORE_MODULE);
      const { resetReplicaSidecars } = await import(WEDGE_MODULE);
      const { randomUUID } = await import("node:crypto");

      let core = new TursoSyncWorkerCore();

      class InProcessClient {
        onCrash(): () => void {
          return () => undefined;
        }
        async send(options: Record<string, unknown>): Promise<unknown> {
          const { timeoutMs: _t, retryOnCrash: _r, ...rest } = options;
          return core.run({ id: randomUUID(), ...(rest as never) });
        }
        async query(o: Record<string, unknown>) {
          return this.send({ ...o, op: "query" });
        }
        async write(o: Record<string, unknown>) {
          return this.send({ ...o, op: "write" });
        }
        async exec(o: Record<string, unknown>) {
          await this.send({ ...o, op: "exec" });
        }
        async sync(o: Record<string, unknown>, op: string) {
          const r = (await this.send({ ...o, op })) as { pulled?: boolean };
          return Boolean(r.pulled);
        }
        async stats(o: Record<string, unknown>) {
          const r = (await this.send({ ...o, op: "stats" })) as { cdcOperations?: number };
          return Number(r.cdcOperations ?? 0);
        }
        async connect(o: Record<string, unknown>) {
          await this.send({ ...o, op: "connect" });
        }
        async close(localPath: string) {
          await this.send({
            op: "close",
            localPath,
            tursoUrl: "",
            authToken: "",
            bootstrapIfEmpty: false,
          });
        }
        async shutdown() {
          await core.closeAll();
          core = new TursoSyncWorkerCore();
        }
        isRunning() {
          return core.openCount() > 0;
        }
      }

      let instance: InProcessClient | null = null;
      return {
        TursoReplicaSyncWorkerClient: InProcessClient,
        getTursoReplicaSyncWorkerClient: () => {
          if (!instance) instance = new InProcessClient();
          return instance;
        },
        shutdownTursoReplicaSyncWorker: async () => {
          await instance?.shutdown();
          instance = null;
        },
        __resetReplicaSidecars: resetReplicaSidecars,
      };
  });
}
