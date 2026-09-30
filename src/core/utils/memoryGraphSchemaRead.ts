/**
 * Schema-priority ordering for knowledge-graph reads.
 *
 * WorkspaceContext is queried first; other active schemas follow alphabetically.
 */

import type Papr from "@papr/memory";
import type { UserGraphSchemaOutput as Schema } from "@papr/memory/resources/schemas.js";

export const WORKSPACE_CONTEXT_SCHEMA_NAME = "WorkspaceContext";

export interface GraphReadSchema {
  id: string;
  name: string;
  status?: string;
  priority: "primary" | "secondary";
  nodeTypeNames: string[];
  relationshipCount: number;
}

function extractNodeTypeNames(schema: Schema): string[] {
  const nodeTypes = schema.node_types;
  if (!nodeTypes) {
    return [];
  }

  if (Array.isArray(nodeTypes)) {
    return nodeTypes
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && "name" in entry) {
          const name = (entry as { name?: string }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter((name): name is string => Boolean(name));
  }

  if (typeof nodeTypes === "object") {
    return Object.keys(nodeTypes);
  }

  return [];
}

function extractRelationshipCount(schema: Schema): number {
  const relationshipTypes = schema.relationship_types;
  if (!relationshipTypes) {
    return 0;
  }
  if (Array.isArray(relationshipTypes)) {
    return relationshipTypes.length;
  }
  if (typeof relationshipTypes === "object") {
    return Object.keys(relationshipTypes).length;
  }
  return 0;
}

function toGraphReadSchema(schema: Schema): GraphReadSchema | null {
  if (!schema.id) {
    return null;
  }

  const isPrimary = schema.name === WORKSPACE_CONTEXT_SCHEMA_NAME;
  return {
    id: schema.id,
    name: schema.name,
    status: schema.status,
    priority: isPrimary ? "primary" : "secondary",
    nodeTypeNames: extractNodeTypeNames(schema),
    relationshipCount: extractRelationshipCount(schema),
  };
}

/** Active schemas with WorkspaceContext first, then others alphabetically by name. */
export async function listSchemasForGraphRead(
  client: Papr,
): Promise<GraphReadSchema[]> {
  try {
    // Do not pass status_filter — production memory.papr.ai had a bug where
    // schema.status.value was called on lenient-parsed string statuses (500).
    // Filter active schemas client-side instead.
    const response = await client.schemas.list({});
    const schemas = (response.data ?? []).filter(
      (schema) => schema.status === "active",
    );

    const primary: GraphReadSchema[] = [];
    const secondary: GraphReadSchema[] = [];

    for (const schema of schemas) {
      const entry = toGraphReadSchema(schema);
      if (!entry) {
        continue;
      }
      if (entry.priority === "primary") {
        primary.push(entry);
      } else {
        secondary.push(entry);
      }
    }

    secondary.sort((a, b) => a.name.localeCompare(b.name));
    return [...primary, ...secondary];
  } catch (error) {
    console.warn(
      "[memoryGraphSchemaRead] schemas.list failed — falling back to GraphQL introspection only:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export function buildGraphReadOrderNote(
  schemas: GraphReadSchema[],
): string {
  if (schemas.length === 0) {
    return "No active schemas found. Use introspect_memory_graph() for GraphQL types.";
  }

  const primary = schemas.filter((s) => s.priority === "primary");
  const secondary = schemas.filter((s) => s.priority === "secondary");

  const lines = [
    "Read order: query WorkspaceContext GraphQL roots first, then secondary schemas.",
  ];

  if (primary.length > 0) {
    for (const schema of primary) {
      const types =
        schema.nodeTypeNames.length > 0
          ? schema.nodeTypeNames.join(", ")
          : "use get_schema for node types";
      lines.push(`Primary (${schema.name}, ${schema.id}): ${types}`);
    }
  } else {
    lines.push(
      `Primary schema "${WORKSPACE_CONTEXT_SCHEMA_NAME}" not found — query introspected GraphQL types.`,
    );
  }

  if (secondary.length > 0) {
    lines.push(
      `Secondary schemas (${secondary.length}): ${secondary.map((s) => s.name).join(", ")}`,
    );
  }

  return lines.join("\n");
}
