/**
 * Central catalog of Papr Cloud capabilities and their requirements.
 * Used by UI (lock modals) and gateway/tool gates.
 */

export type PaprCloudFeatureId =
  | "memory_chat_sync"
  | "memory_add"
  | "memory_search"
  | "memory_graph_search"
  | "memory_schemas"
  | "memory_user_context"
  | "memory_document_upload"
  | "memory_code_index"
  | "papr_ai_proxy"
  | "cloud_sync"
  | "cloud_backup"
  | "vault_sync"
  | "publish_share"
  | "turso_replica"
  | "community_install"
  | "community_contribute";

export type PaprCloudRequirement =
  | "login"
  | "subscription"
  | "cloud_sync_enabled";

export interface PaprCloudFeatureDefinition {
  id: PaprCloudFeatureId;
  label: string;
  description: string;
  requires: readonly PaprCloudRequirement[];
  /** Shown in lock modal when local alternatives still work. */
  localFallback?: string;
}

export const PAPR_CLOUD_FEATURES: Record<
  PaprCloudFeatureId,
  PaprCloudFeatureDefinition
> = {
  memory_chat_sync: {
    id: "memory_chat_sync",
    label: "Cloud chat memory",
    description:
      "Sync chat history across devices and load Papr Memory summaries into conversations.",
    requires: ["login", "subscription"],
    localFallback: "Local chat on this device still works.",
  },
  memory_add: {
    id: "memory_add",
    label: "Save to Papr Memory",
    description:
      "Persist facts, documents, and agent memories to your Papr Memory namespace.",
    requires: ["login", "subscription"],
  },
  memory_search: {
    id: "memory_search",
    label: "Search Papr Memory",
    description: "Semantic search over saved memories and documents.",
    requires: ["login", "subscription"],
  },
  memory_graph_search: {
    id: "memory_graph_search",
    label: "Graph memory search",
    description: "Query entities and relationships in your memory graph.",
    requires: ["login", "subscription"],
  },
  memory_schemas: {
    id: "memory_schemas",
    label: "Memory schemas",
    description: "Register and manage structured memory schemas on Papr Memory.",
    requires: ["login", "subscription"],
  },
  memory_user_context: {
    id: "memory_user_context",
    label: "User memory context",
    description: "Inject profile and workspace memory into agent prompts.",
    requires: ["login", "subscription"],
    localFallback: "Local chat on this device still works.",
  },
  memory_document_upload: {
    id: "memory_document_upload",
    label: "Upload to memory",
    description: "Upload files into Papr Memory for search and retrieval.",
    requires: ["login", "subscription"],
  },
  memory_code_index: {
    id: "memory_code_index",
    label: "Code memory index",
    description: "Index Papr apps and jobs into semantic code memory.",
    requires: ["login", "subscription"],
  },
  papr_ai_proxy: {
    id: "papr_ai_proxy",
    label: "Papr AI models",
    description:
      "Run proxied models (GLM, Kimi, Groq, and other Papr-routed providers) through Papr Memory.",
    requires: ["login", "subscription"],
    localFallback: "Use local Ollama models or add your own API keys.",
  },
  cloud_sync: {
    id: "cloud_sync",
    label: "Cloud sync",
    description:
      "Sync workspace git, linked databases, and credentials with Papr Cloud.",
    requires: ["login", "subscription"],
    localFallback: "Apps, jobs, and chat stay on this device.",
  },
  cloud_backup: {
    id: "cloud_backup",
    label: "Cloud backup",
    description: "Back up workspace data to your Papr Cloud git repository.",
    requires: ["login", "subscription"],
    localFallback: "Your data remains on this device only.",
  },
  vault_sync: {
    id: "vault_sync",
    label: "Cloud credentials vault",
    description:
      "Sync integration keys to the cloud vault for published apps and cloud jobs.",
    requires: ["login", "subscription", "cloud_sync_enabled"],
  },
  publish_share: {
    id: "publish_share",
    label: "Publish & share",
    description:
      "Publish mini-apps to apps.papr.ai and manage sharing settings.",
    requires: ["login", "subscription", "cloud_sync_enabled"],
  },
  turso_replica: {
    id: "turso_replica",
    label: "Cloud database sync",
    description: "Keep linked SQLite databases in sync via Turso replicas.",
    requires: ["login", "subscription", "cloud_sync_enabled"],
  },
  community_install: {
    id: "community_install",
    label: "Install community apps",
    description: "Fork or track published apps from the community catalog.",
    requires: ["login"],
    localFallback: "Build apps locally without installing from the catalog.",
  },
  community_contribute: {
    id: "community_contribute",
    label: "Contribute changes",
    description: "Send change requests back to an app publisher.",
    requires: ["login"],
  },
};

export function getPaprCloudFeature(
  featureId: PaprCloudFeatureId,
): PaprCloudFeatureDefinition {
  return PAPR_CLOUD_FEATURES[featureId];
}

/** Models routed only through Papr Memory proxy (not BYOK). */
export function isPaprProxyOnlyModel(provider: string): boolean {
  return provider === "zai" || provider === "groq" || provider === "moonshot";
}
