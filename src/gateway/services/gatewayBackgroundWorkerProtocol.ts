export type GatewayBackgroundWorkerParentMessage =
  | { type: "run-task"; id: string; taskKey: string }
  | { type: "shutdown" }
  | GatewayBackgroundWorkerRpcResponse;

export type GatewayBackgroundWorkerChildMessage =
  | { type: "ready" }
  | { type: "task-done"; id: string; ok: boolean; error?: string }
  | {
      type: "rpc-request";
      id: string;
      method: GatewayBackgroundRpcMethod;
      payload?: unknown;
    };

export type GatewayBackgroundRpcMethod =
  | "vault-build-push-entries"
  | "vault-apply-push-result";

export type GatewayBackgroundWorkerRpcResponse =
  | { type: "rpc-response"; id: string; ok: true; result: unknown }
  | { type: "rpc-response"; id: string; ok: false; error: string };
