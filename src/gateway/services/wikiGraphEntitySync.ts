/**
 * Lazy wiki ↔ graph sync — only when the Memory wiki loads entities from
 * Papr GraphQL/search (no local entity files). Resolves UUID labels for display,
 * materializes missing local entity stubs, and upserts corrected names to the graph.
 */

import type Papr from "@papr/memory";
import * as fs from "fs";
import * as path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { buildAddPolicy } from "../utils/paprMemoryPolicy.js";
import { buildPaprMemoryWriteScope } from "../utils/memoryScopeResolver.js";
import {
  resolveProjectIdDisplayName,
  resolveUuidToDisplayName,
} from "./storage/codeIndexMetadata.js";
import { isUuidLikeName, isWikiRailExcluded } from "./wikiGraphHelpers.js";

const WIKI_TYPE_TO_GRAPH_LABEL: Record<string, "Person" | "Project"> = {
  person: "Person",
  project: "Project",
};

const WIKI_TYPE_TO_ENTITY_DIR: Record<string, string> = {
  person: "people",
  project: "projects",
  company: "companies",
};

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** Resolve a human display name when graph stores a mini-app/job UUID. */
export function resolveWikiEntityDisplayName(
  record: Record<string, unknown>,
  wikiType: string,
): string | null {
  if (!WIKI_TYPE_TO_GRAPH_LABEL[wikiType]) return null;
  if (isWikiRailExcluded(record, wikiType)) return null;

  const graphLabel = WIKI_TYPE_TO_GRAPH_LABEL[wikiType];
  const name = asString(record.name).trim();
  const projectId = asString(record.project_id).trim();
  const projectType = asString(record.type).trim();

  if (name && !isUuidLikeName(name)) return null;

  const uuidCandidate = isUuidLikeName(name)
    ? name
    : isUuidLikeName(projectId)
      ? projectId
      : "";

  if (!uuidCandidate) return null;

  if (graphLabel === "Project") {
    const resolved = resolveProjectIdDisplayName(
      uuidCandidate,
      projectType || "mini_app",
    );
    return resolved !== uuidCandidate
      ? resolved
      : resolveUuidToDisplayName(uuidCandidate);
  }

  return resolveUuidToDisplayName(uuidCandidate);
}

export function withResolvedWikiLabel(
  record: Record<string, unknown>,
  wikiType: string,
): Record<string, unknown> {
  const resolved = resolveWikiEntityDisplayName(record, wikiType);
  if (!resolved) return record;
  return { ...record, name: resolved };
}

async function upsertGraphEntityName(input: {
  client: Papr;
  entityType: "Person" | "Project";
  nodeId: string;
  newName: string;
  record: Record<string, unknown>;
}): Promise<void> {
  const properties: Record<string, unknown> = {
    id: input.nodeId,
    name: input.newName,
    description: asString(input.record.description) || input.newName,
  };

  if (input.entityType === "Person") {
    properties.role = asString(input.record.role) || "contact";
  } else {
    properties.type =
      asString(input.record.type) ||
      (isUuidLikeName(input.newName) ? "project" : "mini_app");
  }

  const manualPolicy = buildAddPolicy({
    graphMode: "manual",
    manualNodes: [
      {
        id: input.nodeId,
        type: input.entityType,
        properties,
      },
    ],
  });

  const memoryScope = await buildPaprMemoryWriteScope({
    addPolicy: manualPolicy,
  });

  await input.client.memory.add({
    content: `Wiki sync: ${input.entityType} ${input.nodeId} renamed to "${input.newName}"`,
    ...(memoryScope.external_user_id
      ? { external_user_id: memoryScope.external_user_id }
      : {}),
    ...(memoryScope.namespace_id
      ? { namespace_id: memoryScope.namespace_id }
      : {}),
    ...(memoryScope.policy ? { policy: memoryScope.policy } : {}),
  });
}

async function ensureLocalWikiEntity(
  wikiType: string,
  displayName: string,
  description: string,
): Promise<boolean> {
  const typeDir = WIKI_TYPE_TO_ENTITY_DIR[wikiType];
  if (!typeDir || !displayName.trim()) return false;

  const entitiesDir = path.join(getPaprWorkspaceDir(), "entities", typeDir);
  const slug = slugify(displayName);
  if (!slug) return false;

  const filePath = path.join(entitiesDir, `${slug}.md`);
  if (fs.existsSync(filePath)) return false;

  const { createWikiEntity } = await import("./KnowledgeGraphWikiService.js");
  await createWikiEntity(typeDir, displayName, description);
  console.log(`[Wiki] Materialized local entity: ${typeDir}/${slug}.md`);
  return true;
}

export interface WikiGraphEntitySyncResult {
  record: Record<string, unknown>;
  displayName: string;
  localCreated: boolean;
  graphRepaired: boolean;
}

/**
 * Sync one graph row when the wiki is using graph fallback (not local entity files).
 */
export async function syncWikiGraphEntity(
  client: Papr,
  record: Record<string, unknown>,
  wikiType: string,
  options: { allowGraphRepair?: boolean } = {},
): Promise<WikiGraphEntitySyncResult> {
  const graphLabel = WIKI_TYPE_TO_GRAPH_LABEL[wikiType];
  const resolved = resolveWikiEntityDisplayName(record, wikiType);
  const displayName =
    resolved ??
    (asString(record.name).trim() ||
      asString(record.title).trim() ||
      `${wikiType} ${asString(record.id).slice(0, 8)}`);

  const merged = resolved ? { ...record, name: resolved } : record;
  let graphRepaired = false;
  let localCreated = false;

  const nodeId = asString(record.id);
  const oldName = asString(record.name).trim();

  if (
    options.allowGraphRepair !== false &&
    graphLabel &&
    nodeId &&
    resolved &&
    resolved !== oldName
  ) {
    try {
      await upsertGraphEntityName({
        client,
        entityType: graphLabel,
        nodeId,
        newName: resolved,
        record,
      });
      graphRepaired = true;
      console.log(
        `[Wiki] Graph name sync: ${graphLabel} ${nodeId.slice(0, 8)}… "${oldName}" → "${resolved}"`,
      );
    } catch (error) {
      console.warn(
        `[Wiki] Graph name sync failed for ${wikiType}/${nodeId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (WIKI_TYPE_TO_ENTITY_DIR[wikiType]) {
    try {
      localCreated = await ensureLocalWikiEntity(
        wikiType,
        displayName,
        asString(record.description) || displayName,
      );
    } catch (error) {
      console.warn(
        `[Wiki] Local entity materialization failed for ${wikiType}/${displayName}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { record: merged, displayName, localCreated, graphRepaired };
}
