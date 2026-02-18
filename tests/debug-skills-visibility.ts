/**
 * System Prompt Debug - Check why skills section isn't appearing
 */

import { SystemPromptBuilder } from "../src/core/agents/SystemPrompt.js";

const builder = new SystemPromptBuilder({
  userDataPath: "/test/path",
  workspacePath: "/test/workspace",
  availableTools: ["read_file", "read_skill", "create_app"],
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

const prompt = builder.build();

console.log("Active skills passed:", JSON.stringify(builder["options"]?.activeSkills, null, 2));
console.log("\n" + "=".repeat(80));
console.log("Checking for skills sections:");
console.log("=".repeat(80));

if (prompt.includes("# Installed Skills Directory")) {
  console.log("✅ Found: '# Installed Skills Directory'");
  const match = prompt.match(/# Installed Skills Directory([\s\S]{0,500})/);
  if (match) {
    console.log("\nContent preview:");
    console.log(match[1].slice(0, 400));
  }
} else {
  console.log("❌ NOT FOUND: '# Installed Skills Directory'");
}

if (prompt.includes("# Built-in Skills (Always Available)")) {
  console.log("\n✅ Found: '# Built-in Skills (Always Available)' (fallback)");
} else {
  console.log("\n❌ NOT FOUND: '# Built-in Skills (Always Available)'");
}

console.log("\n" + "=".repeat(80));
console.log("Total prompt length:", prompt.length);
