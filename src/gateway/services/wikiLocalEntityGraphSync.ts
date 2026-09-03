/**
 * Sync local wiki entity files → Papr Memory graph (Neo4j) via manual graph override.
 * Triggered when Sleep/Wiki/create_app materialize entity markdown under workspace/entities/.
 */

import type Papr from "@papr/memory";
import { getPaprClient } from "../../core/tools/paprClient.js";
import { buildAddPolicy } from "../utils/paprMemoryPolicy.js";
import { buildPaprMemoryWriteScope } from "../utils/memoryScopeResolver.js";
import { resolveWorkspaceContextSchemaId } from "../utils/workspaceContextSchema.js";

type GraphEntityLabel = "Person" | "Company" | "Project";

const ENTITY_DIR_TO_GRAPH: Record<string, GraphEntityLabel> = {
  people: "Person",
  companies: "Company",
  projects: "Project",
  apps: "Project",
};

const ENTITY_DIR_TO_SINGULAR: Record<string, string> = {
  people: "person",
  companies: "company",
  projects: "project",
  apps: "app",
};

export interface SyncLocalWikiEntityInput {
  entityDir: string;
  slug: string;
  name: string;
  description?: string;
  appId?: string;
  kind?: string;
  source?: string;
  client?: Papr;
}

function buildNodeProperties(
  label: GraphEntityLabel,
  input: SyncLocalWikiEntityInput,
  nodeId: string,
): Record<string, unknown> {
  const description =
    input.description?.trim() || input.name.trim() || nodeId;

  if (label === "Person") {
    return {
      id: nodeId,
      name: input.name.trim(),
      description,
      role: "contact",
    };
  }

  if (label === "Company") {
    return {
      id: nodeId,
      name: input.name.trim(),
      description,
    };
  }

  // Project — includes mini-apps under apps/
  return {
    id: nodeId,
    name: input.name.trim(),
    description,
    status: "active",
    ...(input.entityDir === "apps"
      ? {
          type: input.kind?.trim() || "mini_app",
          ...(input.appId ? { project_id: input.appId, app_id: input.appId } : {}),
        }
      : {}),
  };
}

export async function syncLocalWikiEntityToGraph(
  input: SyncLocalWikiEntityInput,
): Promise<{ synced: boolean; nodeId?: string; error?: string }> {
  const graphLabel = ENTITY_DIR_TO_GRAPH[input.entityDir];
  const singular = ENTITY_DIR_TO_SINGULAR[input.entityDir];
  if (!graphLabel || !singular || !input.slug.trim() || !input.name.trim()) {
    return { synced: false, error: "Unsupported or incomplete entity" };
  }

  try {
    const client = input.client ?? (await getPaprClient());
    const schemaId = await resolveWorkspaceContextSchemaId(client);
    if (!schemaId) {
      return {
        synced: false,
        error: "WorkspaceContext schema not found — graph sync skipped",
      };
    }

    const nodeId = `${singular}/${input.slug.trim()}`;
    const properties = buildNodeProperties(graphLabel, input, nodeId);

    const manualPolicy = buildAddPolicy({
      graphMode: "manual",
      graphSchemaId: schemaId,
      manualNodes: [
        {
          id: nodeId,
          type: graphLabel,
          properties,
        },
      ],
    });

    const memoryScope = await buildPaprMemoryWriteScope({
      addPolicy: manualPolicy,
    });

    await client.memory.add({
      content: [
        `Wiki entity synced to graph: ${graphLabel} "${input.name.trim()}"`,
        input.description?.trim() ? input.description.trim() : "",
        input.source ? `Source: ${input.source}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ...(memoryScope.user_id
        ? { user_id: memoryScope.user_id }
        : {}),
      ...(memoryScope.namespace_id
        ? { namespace_id: memoryScope.namespace_id }
        : {}),
      ...(memoryScope.policy ? { policy: memoryScope.policy } : {}),
      metadata: {
        role: "assistant",
        category: "context",
        customMetadata: {
          content_type: "wiki_entity_sync",
          wiki_entity_id: nodeId,
          wiki_entity_type: singular,
          ...(input.appId ? { app_id: input.appId } : {}),
        },
      },
    });

    console.log(`[Wiki] Graph sync: ${nodeId} → ${graphLabel}`);
    return { synced: true, nodeId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Wiki] Graph sync failed for ${input.entityDir}/${input.slug}:`, message);
    return { synced: false, error: message };
  }
}

/** Parse frontmatter fields from a newly written entity markdown file. */
export function parseWikiEntityFrontmatter(content: string): {
  name?: string;
  description?: string;
  appId?: string;
  kind?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }

  const block = match[1];
  const readField = (key: string): string | undefined => {
    const line = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!line) return undefined;
    return line[1].trim().replace(/^["']|["']$/g, "");
  };

  return {
    name: readField("name"),
    description: readField("description_short") ?? readField("description"),
    appId: readField("app_id"),
    kind: readField("kind"),
  };
}

/** Match paths like .../workspace/entities/{type}/{slug}.md */
export function parseWikiEntityFilePath(
  filePath: string,
): { entityDir: string; slug: string } | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(
    /\/workspace\/entities\/([^/]+)\/([^/]+)\.md$/i,
  );
  if (!match) {
    return null;
  }
  return { entityDir: match[1], slug: match[2] };
}

export async function syncWikiEntityFileToGraph(input: {
  filePath: string;
  content: string;
  source?: string;
}): Promise<void> {
  const parsed = parseWikiEntityFilePath(input.filePath);
  if (!parsed) {
    return;
  }

  const fm = parseWikiEntityFrontmatter(input.content);
  const name =
    fm.name?.trim() ||
    parsed.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  await syncLocalWikiEntityToGraph({
    entityDir: parsed.entityDir,
    slug: parsed.slug,
    name,
    description: fm.description,
    appId: fm.appId,
    kind: fm.kind,
    source: input.source ?? "write_file",
  });
}
