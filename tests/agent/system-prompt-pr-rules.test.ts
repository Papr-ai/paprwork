import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/agents/SystemPrompt.js";

describe("SystemPrompt - pull request rules", () => {
  const prompt = buildSystemPrompt({ userDataPath: "/t", workspacePath: "/w", availableTools: ["bash"], customKeys: [] });

  it("tells agents to use the repo PR template and link a ticket", () => {
    expect(prompt).toContain("pull_request_template.md");
    expect(prompt).toMatch(/create the issue first/);
  });

  it("does not teach git add . and warns about node_modules symlinks", () => {
    expect(prompt).not.toContain("git add . && git commit");
    expect(prompt).toMatch(/symlink `node_modules`/);
  });
});
