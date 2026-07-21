#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { buildSystemPrompt } from "../dist/core/agents/SystemPrompt.js";
import { getAllToolIds } from "../dist/core/tools/index.js";

const prompt = buildSystemPrompt({
  userDataPath: `${process.env.HOME}/.paprwork-v2`,
  workspacePath: process.cwd(),
  availableTools: getAllToolIds(),
  customKeys: [],
  includeExtendedAppPlaybook: true,
  provider: "openai",
});

const header = `# Paprwork System Prompt Export

> Auto-generated on ${new Date().toISOString()}
> Full default system prompt with all tools and extended app playbook enabled.
> Live prompts may differ per chat (skills, plans, workspace files, custom keys, provider).

**Length:** ${prompt.length.toLocaleString()} characters (~${Math.round(prompt.length / 4).toLocaleString()} tokens est.)

---

`;

const outPath = "docs/SYSTEM_PROMPT_EXPORT.md";
writeFileSync(outPath, header + prompt, "utf8");
console.log(`Written: ${outPath}`);
console.log(`Length: ${prompt.length} chars`);
