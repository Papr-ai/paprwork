/**
 * Mini-app backend manifest (apps/{appId}/backend/manifest.json).
 */

export type AppBackendRuntime = "python" | "node" | "typescript";

export interface AppBackendActionSpec {
  handler: string;
  runtime: AppBackendRuntime;
  /** Linked DB alias for this handler (same as /api/db/* sourceId). Omit → legacy default or params.sourceId. */
  sourceId?: string;
  keys?: string[];
  timeoutMs?: number;
  description?: string;
  /**
   * JSON Schema (object) for the action's params. Lets Claude call the action as a
   * typed tool and lets default cards render a form. Params still arrive as strings.
   */
  input?: AppBackendInputSchema;
  /**
   * What the action does to the world. Claude cards gate `external` behind an
   * explicit approval, and only `read` actions become read-only tools.
   * Omitted → treated as `write`.
   */
  effect?: AppBackendEffect;
  /** Where it runs. `mac` actions start when the publisher's Mac is awake. Default `cloud`. */
  runsOn?: AppBackendRunsOn;
}

export type AppBackendEffect = "read" | "write" | "external";
export type AppBackendRunsOn = "cloud" | "mac";

export interface AppBackendInputField {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  default?: string | number | boolean;
  format?: string;
  maxLength?: number;
}

export interface AppBackendInputSchema {
  type: "object";
  properties: Record<string, AppBackendInputField>;
  required?: string[];
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
