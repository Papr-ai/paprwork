/**
 * Background Node child for heavy coalesced work (Phase C).
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  GatewayBackgroundWorkerChildMessage,
  GatewayBackgroundWorkerParentMessage,
  GatewayBackgroundWorkerRpcResponse,
  GatewayBackgroundRpcMethod,
} from "./gatewayBackgroundWorkerProtocol.js";
import {
  GATEWAY_BACKGROUND_CHILD_TASKS,
  isGatewayBackgroundProcessEnabled,
} from "./gatewayBackgroundConcurrency.js";
import { getVaultSyncService } from "./VaultSyncService.js";

const BOOT_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 600_000;

let clientInstance: GatewayBackgroundWorkerClient | undefined;

function workerEntryPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "gatewayBackgroundWorkerEntry.js",
  );
}

export class GatewayBackgroundWorkerClient {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pendingTasks = new Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingRpc = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  isEnabled(): boolean {
    return isGatewayBackgroundProcessEnabled();
  }

  async ensureStarted(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    if (this.child && this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this.spawnChild();
    return this.readyPromise;
  }

  private spawnChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = workerEntryPath();
      const child = fork(entry, [], {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      this.child = child;
      let bootResolved = false;

      const bootTimer = setTimeout(() => {
        reject(new Error("[GatewayBackgroundWorker] Boot timeout"));
      }, BOOT_TIMEOUT_MS);

      child.on("message", (msg: GatewayBackgroundWorkerChildMessage) => {
        this.handleChildMessage(msg, () => {
          if (bootResolved) {
            return;
          }
          bootResolved = true;
          clearTimeout(bootTimer);
          resolve();
        });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          console.warn(`[GatewayBackgroundWorker] ${text}`);
        }
      });

      child.on("error", (err) => {
        clearTimeout(bootTimer);
        reject(err);
      });

      child.on("exit", (code) => {
        this.child = null;
        this.readyPromise = null;
        const err = new Error(
          `[GatewayBackgroundWorker] Child exited (${code ?? "signal"})`,
        );
        for (const [, pending] of this.pendingTasks) {
          clearTimeout(pending.timer);
          pending.reject(err);
        }
        this.pendingTasks.clear();
        for (const [, pending] of this.pendingRpc) {
          clearTimeout(pending.timer);
          pending.reject(err);
        }
        this.pendingRpc.clear();
      });
    });
  }

  private handleChildMessage(
    msg: GatewayBackgroundWorkerChildMessage,
    onReady: () => void,
  ): void {
    if (msg.type === "ready") {
      console.log("[GatewayBackgroundWorker] Child ready");
      onReady();
      return;
    }

    if (msg.type === "task-done") {
      const pending = this.pendingTasks.get(msg.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingTasks.delete(msg.id);
      if (msg.ok) {
        pending.resolve();
      } else {
        pending.reject(new Error(msg.error ?? "Background task failed"));
      }
      return;
    }

    if (msg.type === "rpc-request") {
      void this.handleRpcRequest(msg.id, msg.method, msg.payload);
    }
  }

  private async handleRpcRequest(
    id: string,
    method: GatewayBackgroundRpcMethod,
    payload: unknown,
  ): Promise<void> {
    const respond = (response: GatewayBackgroundWorkerRpcResponse): void => {
      this.child?.send(response);
    };

    try {
      const vault = getVaultSyncService();
      if (!vault) {
        throw new Error("VaultSyncService not initialized");
      }

      if (method === "vault-build-push-entries") {
        const entries = await vault.buildVaultPushEntriesForBackground();
        respond({ type: "rpc-response", id, ok: true, result: entries });
        return;
      }

      if (method === "vault-apply-push-result") {
        await vault.applyVaultPushResultFromBackground(
          payload as import("./vaultSyncBackgroundPush.js").VaultSyncPushResult,
        );
        respond({ type: "rpc-response", id, ok: true, result: null });
        return;
      }

      throw new Error(`Unknown RPC method: ${method}`);
    } catch (err) {
      respond({
        type: "rpc-response",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async runTask(taskKey: string): Promise<void> {
    if (!GATEWAY_BACKGROUND_CHILD_TASKS.has(taskKey)) {
      throw new Error(`Task not delegated to background child: ${taskKey}`);
    }
    await this.ensureStarted();
    if (!this.child) {
      throw new Error("[GatewayBackgroundWorker] Child not running");
    }

    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error(`Background task timed out: ${taskKey}`));
      }, TASK_TIMEOUT_MS);

      this.pendingTasks.set(id, { resolve, reject, timer });
      const msg: GatewayBackgroundWorkerParentMessage = {
        type: "run-task",
        id,
        taskKey,
      };
      this.child?.send(msg);
    });

    if (
      taskKey === "papr:resume-cloud" ||
      taskKey === "vault:workspace-switch"
    ) {
      const vault = getVaultSyncService();
      if (vault) {
        await vault.pullKeys();
        await vault.pullSharedKeys();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    child.send({ type: "shutdown" } satisfies GatewayBackgroundWorkerParentMessage);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.readyPromise = null;
  }
}

export function getGatewayBackgroundWorkerClient(): GatewayBackgroundWorkerClient {
  if (!clientInstance) {
    clientInstance = new GatewayBackgroundWorkerClient();
  }
  return clientInstance;
}

export async function ensureGatewayBackgroundWorkerStarted(): Promise<void> {
  if (!isGatewayBackgroundProcessEnabled()) {
    return;
  }
  await getGatewayBackgroundWorkerClient().ensureStarted();
}

export async function shutdownGatewayBackgroundWorker(): Promise<void> {
  await clientInstance?.shutdown();
  clientInstance = undefined;
}
