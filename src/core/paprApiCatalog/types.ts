/**
 * Unified Papr API catalog — machine-readable contracts for agents and mini-apps.
 */

export type PaprApiRuntime = "desktop" | "cloud";

export type PaprApiSurface =
  | "mini-app-http"
  | "mini-app-sdk"
  | "agent-tool"
  | "desktop-gateway"
  | "cloud-gateway";

export interface PaprApiBodyField {
  name: string;
  description: string;
  required?: boolean;
}

export interface PaprApiCatalogEntry {
  /** Stable kebab id */
  id: string;
  title: string;
  summary: string;
  surfaces: PaprApiSurface[];
  runtimes: PaprApiRuntime[];
  /** HTTP method when applicable */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Primary path or route pattern */
  path?: string;
  /** Alternate paths (same handler) */
  pathAliases?: string[];
  /** Agent tool id */
  toolId?: string;
  /** Mini-app SDK import route */
  sdkRoute?: string;
  bodyFields?: PaprApiBodyField[];
  /** Human-readable limits (batch size, rate limits, etc.) */
  limits?: string[];
  /** Copy-paste example (fetch or tool call) */
  example?: string;
  /** Skill or agent-doc section for workflow (not contract) */
  playbookRef?: string;
  /** Search tokens — lowercase */
  keywords: string[];
}

export interface PaprApiCatalog {
  version: number;
  generatedAt: string;
  entryCount: number;
  entries: PaprApiCatalogEntry[];
}

export type PaprApiCatalogSurfaceFilter = PaprApiSurface | "any";
