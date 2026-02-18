/**
 * System Prompt Debug - Output actual prompt for inspection
 */

import { buildSystemPrompt } from "../src/core/agents/SystemPrompt.js";
import { writeFileSync } from "fs";

const prompt = buildSystemPrompt({
  userDataPath: "/test/path",
  workspacePath: "/test/workspace",
  availableTools: ["read_file", "read_skill", "create_app", "create_plan"],
  customKeys: [],
  activeSkills: [
    {
      id: "preloaded-paprwork-design-system",
      name: "Paprwork Design System",
      description: "Complete design system for mini-apps"
    }
  ],
});

// Write to file for inspection
writeFileSync("/tmp/paprwork-system-prompt-debug.txt", prompt, "utf8");

console.log("=".repeat(80));
console.log("SYSTEM PROMPT LENGTH:", prompt.length);
console.log("=".repeat(80));

// Check key sections
const sections = [
  "# Agent Documentation (Built-in)",
  "# Installed Skills Directory", 
  "# Built-in Skills (Always Available)",
  "00-START-HERE.md",
  "preloaded-paprwork-design-system",
];

sections.forEach(section => {
  const pos = prompt.indexOf(section);
  if (pos >= 0) {
    const percentage = ((pos / prompt.length) * 100).toFixed(1);
    console.log(`✅ Found "${section}" at position ${pos} (${percentage}% into prompt)`);
  } else {
    console.log(`❌ NOT FOUND: "${section}"`);
  }
});

console.log("=".repeat(80));
console.log("Full prompt written to: /tmp/paprwork-system-prompt-debug.txt");
console.log("=".repeat(80));
