/**
 * Mini-app backend manifest (apps/{appId}/backend/manifest.json).
 */

export type AppBackendRuntime = "python" | "node" | "typescript";

export interface AppBackendActionSpec {
  handler: string;
  runtime: AppBackendRuntime;
  keys?: string[];
  timeoutMs?: number;
  description?: string;
}

export interface AppBackendManifest {
  version: 1;
  actions: Record<string, AppBackendActionSpec>;
}

export interface AppBackendRunParams {
  appId: string;
  action: string;
  params?: Record<string, string>;
}

export interface AppBackendRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
