/**
 * System Prompt Content Tests
 *
 * Verifies that the system prompt includes critical sections:
 * - Agent documentation references
 * - Skills with IDs
 * - Design system instructions
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/core/agents/SystemPrompt.js";

describe("SystemPrompt - Agent Docs & Skills Visibility", () => {
  it("should include Agent Documentation section early in prompt", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      workspacePath: "/test/workspace",
      availableTools: ["read_file", "read_skill", "create_app"],
      customKeys: [],
    });

    expect(prompt).toContain("# Agent Documentation (Built-in)");

    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/00-START-HERE.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/APP_AND_JOBS_GUIDE.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/API_KEY_TESTING_PROTOCOL.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/DECISION_TREE_AGENT_CAPABILITIES.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/QUICK_EXAMPLES.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/DELEGATION_STRATEGY.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/AGENT_SETUP_WORKFLOW.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/SUBAGENT_CREATION_GUIDE.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md" })',
    );
    expect(prompt).toContain(
      'read_file({ path: "src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md" })',
    );

    expect(prompt).toContain("These docs are files in the current workspace");
    expect(prompt).not.toMatch(
      /read_file\(\{ path: "~\/Papr-jobs\//,
    );
  });

  it("should show Agent Documentation section BEFORE API Keys section", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_file"],
      customKeys: [],
    });

    const agentDocsPos = prompt.indexOf("# Agent Documentation (Built-in)");
    const apiKeysPos = prompt.indexOf("# 🔑 API Keys & Credentials");

    expect(agentDocsPos).toBeGreaterThan(0);
    expect(apiKeysPos).toBeGreaterThan(0);
    expect(agentDocsPos).toBeLessThan(apiKeysPos);
  });

  it("should include skills directory fallback when no activeSkills provided", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_skill"],
      customKeys: [],
    });

    expect(prompt).toContain("# Skills Directory");
    expect(prompt).toContain("read_skill()");
    expect(prompt).toContain(
      'read_skill({ skillId: "preloaded-app-and-jobs-guide" })',
    );
    expect(prompt).toContain(
      'read_skill({ skillId: "preloaded-paprwork-design-system" })',
    );
  });

  it("should include skills with IDs when activeSkills are provided", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_skill"],
      customKeys: [],
      activeSkills: [
        {
          id: "preloaded-paprwork-design-system",
          name: "Paprwork Design System",
          description: "Complete design system for mini-apps",
        },
        {
          id: "test-skill-123",
          name: "Test Skill",
          description: "A test skill",
        },
      ],
    });

    expect(prompt).toContain("# Installed Skills Directory");
    expect(prompt).toContain(
      "**Paprwork Design System** (`preloaded-paprwork-design-system`)",
    );
    expect(prompt).toContain("**Test Skill** (`test-skill-123`)");
    expect(prompt).toContain(
      "Use the exact skillId shown in parentheses above",
    );
  });

  it("should include design system loading in app creation instructions", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["create_app", "read_skill", "read_file"],
      customKeys: [],
      includeExtendedAppPlaybook: true,
    });

    expect(prompt).toContain("**3. Load Documentation BEFORE Starting:**");
    expect(prompt).toContain(
      'read_skill({ skillId: "preloaded-app-and-jobs-guide" })',
    );
    expect(prompt).toContain("**4. ALWAYS Load Design System");
    expect(prompt).toContain(
      'read_skill({ skillId: "preloaded-paprwork-design-system" })',
    );
    expect(prompt).toContain("This is NOT optional");
  });

  it("should include create_plan guidance in app creation section", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["create_app", "create_plan"],
      customKeys: [],
      includeExtendedAppPlaybook: true,
    });

    expect(prompt).toContain("**2. Create a Plan (after brief for complex work):**");
    expect(prompt).toContain('{ id: "design", description: "Design UI layout" }');
    expect(prompt).toContain('{ id: "build", description: "Build components" }');
    expect(prompt).toContain('{ id: "test", description: "Test functionality" }');
  });

  it("should show agent docs section even with minimal options", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: [],
      customKeys: [],
    });

    expect(prompt).toContain("# Agent Documentation (Built-in)");
    expect(prompt).toContain("Start here");
    expect(prompt).toContain("00-START-HERE.md");
  });

  it("should position agent docs early enough to not be truncated", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_file"],
      customKeys: [],
    });

    const agentDocsPos = prompt.indexOf("# Agent Documentation (Built-in)");
    const totalLength = prompt.length;
    const positionPercentage = (agentDocsPos / totalLength) * 100;

    expect(agentDocsPos).toBeGreaterThan(0);
    expect(positionPercentage).toBeLessThan(30);
  });
});
