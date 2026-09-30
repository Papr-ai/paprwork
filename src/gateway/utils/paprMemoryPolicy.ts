/**
 * Helpers for Papr Memory unified policy API (SDK 2.7+).
 *
 * - Add: policy.transform_embedding (replaces enable_holographic query params)
 * - Add: policy.graph (replaces top-level memory_policy for graph control)
 * - Search: policy.vector (replaces holographic_config)
 */

import type { MemorySearchParams } from "@papr/memory/resources/memory.js";
import type {
  GraphPolicyBlock,
  MemoryAddPolicy,
} from "@papr/memory/resources/shared.js";

/** Built-in signal domain shortnames resolved by the memory server. */
export type PaprSignalDomainId =
  | "general"
  | "code"
  | "cosqa"
  | "scifact"
  | "legal"
  | "medical"
  | "ecommerce"
  | string;

export function normalizeSignalDomainId(
  domainId: string | undefined,
): string | undefined {
  if (!domainId) {
    return undefined;
  }
  const trimmed = domainId.trim();
  if (trimmed === "default") {
    return "general";
  }
  return trimmed;
}

export function buildAddTransformEmbedding(
  signalDomain: string | undefined,
): MemoryAddPolicy["transform_embedding"] | undefined {
  const normalized = normalizeSignalDomainId(signalDomain);
  if (!normalized) {
    return undefined;
  }
  return {
    mode: "auto",
    domain_id: normalized,
  };
}

export function buildAddPolicy(input: {
  signalDomain?: string;
  graphSchemaId?: string;
  graphMode?: "auto" | "manual";
  manualNodes?: GraphPolicyBlock["nodes"];
  manualRelationships?: GraphPolicyBlock["relationships"];
}): MemoryAddPolicy | undefined {
  const transform_embedding = buildAddTransformEmbedding(input.signalDomain);

  let graph: GraphPolicyBlock | undefined;
  if (
    input.graphSchemaId ||
    input.graphMode === "manual" ||
    input.graphMode === "auto"
  ) {
    graph = {
      mode: input.graphMode ?? "auto",
      ...(input.graphSchemaId ? { schema_id: input.graphSchemaId } : {}),
      ...(input.manualNodes ? { nodes: input.manualNodes } : {}),
      ...(input.manualRelationships
        ? { relationships: input.manualRelationships }
        : {}),
    };
  }

  if (!transform_embedding && !graph) {
    return undefined;
  }

  return {
    ...(transform_embedding ? { transform_embedding } : {}),
    ...(graph ? { graph } : {}),
  };
}

export interface VectorPolicyInput {
  domainId?: string;
  returnSignalScores?: boolean;
  signalThresholds?: Record<string, number>;
}

export function buildSearchVectorPolicy(
  input: VectorPolicyInput | undefined,
  defaultDomain?: PaprSignalDomainId,
): NonNullable<MemorySearchParams.Policy>["vector"] | undefined {
  const explicitVectorPolicy =
    Boolean(input?.domainId) ||
    Boolean(input?.returnSignalScores) ||
    Boolean(
      input?.signalThresholds &&
        Object.keys(input.signalThresholds).length > 0,
    );

  if (!explicitVectorPolicy && !defaultDomain) {
    return undefined;
  }

  return {
    mode: "enhanced",
    domain_id:
      normalizeSignalDomainId(input?.domainId) ??
      defaultDomain ??
      "general",
    ...(input?.returnSignalScores ? { return_signal_scores: true } : {}),
    ...(input?.signalThresholds &&
    Object.keys(input.signalThresholds).length > 0
      ? { signal_thresholds: input.signalThresholds }
      : {}),
  };
}

export function buildSearchPolicy(input: {
  vectorPolicy?: VectorPolicyInput;
  defaultDomain?: PaprSignalDomainId;
}): MemorySearchParams.Policy | undefined {
  const vector = buildSearchVectorPolicy(
    input.vectorPolicy,
    input.defaultDomain,
  );
  if (!vector) {
    return undefined;
  }
  return { vector };
}

/** Source code indexing: plain vector add — no graph extraction, no holographic transform.
 *  Code search uses the base Qwen embedding; holographic/code-domain transforms and
 *  LLM graph extraction are unnecessary overhead for bulk file indexing. */
export function buildCodeIndexAddPolicy(_schemaId: string): MemoryAddPolicy {
  return {
    transform_embedding: {
      mode: "none",
    },
    graph: {
      mode: "none",
    },
  };
}
