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

    // Should contain the Agent Documentation section
    expect(prompt).toContain("# Agent Documentation (Built-in)");
    
    // Should list all 7 docs with exact read_file commands
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/00-START-HERE.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/APP_AND_JOBS_GUIDE.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/API_KEY_TESTING_PROTOCOL.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/DECISION_TREE_AGENT_CAPABILITIES.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/QUICK_EXAMPLES.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/DELEGATION_STRATEGY.md" })');
    expect(prompt).toContain('read_file({ path: "src/resources/agent-docs/AGENT_SETUP_WORKFLOW.md" })');
    
    // Should have the important note
    expect(prompt).toContain("These docs are files in the current workspace");
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
    expect(agentDocsPos).toBeLessThan(apiKeysPos); // Agent docs should come first
  });

  it("should include preloaded design system skill when no activeSkills provided", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_skill"],
      customKeys: [],
      // No activeSkills provided
    });

    // Should show fallback Built-in Skills section
    expect(prompt).toContain("# Built-in Skills (Always Available)");
    expect(prompt).toContain("Paprwork Design System (Liquid Glass)");
    expect(prompt).toContain('read_skill({ skillId: "preloaded-paprwork-design-system" })');
    expect(prompt).toContain("This skill is preloaded with Paprwork");
    expect(prompt).toContain("You do NOT need to install it from any marketplace");
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
          description: "Complete design system for mini-apps"
        },
        {
          id: "test-skill-123",
          name: "Test Skill",
          description: "A test skill"
        }
      ],
    });

    // Should show Installed Skills Directory section
    expect(prompt).toContain("# Installed Skills Directory");
    
    // Should show each skill with its ID
    expect(prompt).toContain("**Paprwork Design System** (`preloaded-paprwork-design-system`)");
    expect(prompt).toContain('read_skill({ skillId: "preloaded-paprwork-design-system" })');
    
    expect(prompt).toContain("**Test Skill** (`test-skill-123`)");
    expect(prompt).toContain('read_skill({ skillId: "test-skill-123" })');
  });

  it("should include design system loading in app creation instructions", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["create_app", "read_skill", "read_file"],
      customKeys: [],
      includeExtendedAppPlaybook: true,
    });

    // Should mention loading design system in CRITICAL section
    expect(prompt).toContain("CRITICAL: Load Documentation First!");
    expect(prompt).toContain('read_skill({ skillId: "preloaded-paprwork-design-system" })');
    expect(prompt).toContain("ALREADY PRELOADED - just read it");
    
    // Should be in the extended playbook too
    expect(prompt).toContain("STEP 1: Load Documentation (REQUIRED)");
    expect(prompt).toContain("ALREADY AVAILABLE in Paprwork");
  });

  it("should include agent docs loading in app creation plan", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["create_app", "create_plan"],
      customKeys: [],
      includeExtendedAppPlaybook: true,
    });

    // Plan should include load_docs step
    expect(prompt).toContain('{ id: "load_docs", title: "Load agent-docs & design system"');
    expect(prompt).toContain('{ id: "check", title: "Check existing apps"');
    expect(prompt).toContain('{ id: "design", title: "Design UI following Liquid Glass"');
  });

  it("should show agent docs section even with minimal options", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: [],
      customKeys: [],
    });

    // Agent docs should ALWAYS be present
    expect(prompt).toContain("# Agent Documentation (Built-in)");
    expect(prompt).toContain("START HERE");
    expect(prompt).toContain("00-START-HERE.md");
  });

  it("should position agent docs early enough to not be truncated", () => {
    const prompt = buildSystemPrompt({
      userDataPath: "/test/path",
      availableTools: ["read_file"],
      customKeys: [],
    });

    // Check position in prompt (should be in first 30% of content)
    const agentDocsPos = prompt.indexOf("# Agent Documentation (Built-in)");
    const totalLength = prompt.length;
    const positionPercentage = (agentDocsPos / totalLength) * 100;

    expect(agentDocsPos).toBeGreaterThan(0);
    expect(positionPercentage).toBeLessThan(30); // Should be in first 30% of prompt
  });
});
