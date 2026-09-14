/**
 * Child process entry — vault push HTTP and other isolated background tasks.
 */

import { randomUUID } from "node:crypto";
import type {
  GatewayBackgroundWorkerChildMessage,
  GatewayBackgroundWorkerParentMessage,
  GatewayBackgroundRpcMethod,
} from "./gatewayBackgroundWorkerProtocol.js";
import { runBackgroundTaskInChild } from "./gatewayBackgroundWorkerHandlers.js";

const pendingRpc = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function send(msg: GatewayBackgroundWorkerChildMessage): void {
  process.send?.(msg);
}

async function rpcParent(
  method: GatewayBackgroundRpcMethod,
  payload?: unknown,
): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 120_000);

    pendingRpc.set(id, { resolve, reject, timer });
    send({ type: "rpc-request", id, method, payload });
  });
}

function handleParentMessage(raw: unknown): void {
  const msg = raw as GatewayBackgroundWorkerParentMessage;

  if (msg.type === "rpc-response") {
    const pending = pendingRpc.get(msg.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingRpc.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error));
    }
    return;
  }

  if (msg.type === "shutdown") {
    process.exit(0);
    return;
  }

  if (msg.type !== "run-task") {
    return;
  }

  void (async () => {
    try {
      await runBackgroundTaskInChild(msg.taskKey, rpcParent);
      send({ type: "task-done", id: msg.id, ok: true });
    } catch (err) {
      send({
        type: "task-done",
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

process.on("message", handleParentMessage);
send({ type: "ready" });
