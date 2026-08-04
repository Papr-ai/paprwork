import { describe, expect, it } from "vitest";
import {
  UPDATE_WORKSPACE_ORG,
  assertUpdateWorkspaceOrgMutation,
} from "../src/core/papr/paprLoginGraphql.js";

describe("UPDATE_WORKSPACE_ORG GraphQL mutation", () => {
  it("selects workSpace on UpdateWorkSpacePayload", () => {
    expect(() => assertUpdateWorkspaceOrgMutation(UPDATE_WORKSPACE_ORG)).not.toThrow();
    expect(UPDATE_WORKSPACE_ORG).toContain("workSpace {");
    expect(UPDATE_WORKSPACE_ORG).not.toMatch(/updateWorkSpace[\s\S]*\bworkspace\s*\{/);
  });

  it("rejects the old invalid workspace selection", () => {
    const invalid = UPDATE_WORKSPACE_ORG.replace("workSpace {", "workspace {");
    expect(() => assertUpdateWorkspaceOrgMutation(invalid)).toThrow(/workSpace/i);
  });
});
