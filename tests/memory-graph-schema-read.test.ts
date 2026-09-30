import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CONTEXT_SCHEMA_NAME,
  buildGraphReadOrderNote,
  type GraphReadSchema,
} from "../src/core/utils/memoryGraphSchemaRead.js";

describe("memoryGraphSchemaRead", () => {
  it("buildGraphReadOrderNote prioritizes WorkspaceContext", () => {
    const schemas: GraphReadSchema[] = [
      {
        id: "ws-1",
        name: WORKSPACE_CONTEXT_SCHEMA_NAME,
        priority: "primary",
        nodeTypeNames: ["Person", "Company", "Project"],
        relationshipCount: 4,
      },
      {
        id: "code-1",
        name: "paprwork-code",
        priority: "secondary",
        nodeTypeNames: ["CodeFile", "Project"],
        relationshipCount: 9,
      },
    ];

    const note = buildGraphReadOrderNote(schemas);
    expect(note).toContain("WorkspaceContext");
    expect(note).toContain("Person, Company, Project");
    expect(note).toContain("Secondary schemas");
    expect(note).toContain("paprwork-code");
  });

  it("buildGraphReadOrderNote handles missing WorkspaceContext", () => {
    const note = buildGraphReadOrderNote([
      {
        id: "code-1",
        name: "paprwork-code",
        priority: "secondary",
        nodeTypeNames: ["CodeFile"],
        relationshipCount: 1,
      },
    ]);

    expect(note).toContain('Primary schema "WorkspaceContext" not found');
  });
});
