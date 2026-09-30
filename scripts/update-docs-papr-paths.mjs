#!/usr/bin/env node
/**
 * Rewrite legacy flat ~/Papr/{apps,Jobs,jobs,data,...} paths in markdown docs
 * to $PAPR_HOME/... (active org/namespace workspace shorthand).
 *
 * Usage: node scripts/update-docs-papr-paths.mjs
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DOC_GLOBS = [
  "docs",
  "src/resources/agent-docs",
  "src/resources/skills",
  "src/resources/workspace-templates",
  "src/resources/default-apps",
];

const ROOT_MD_FILES = ["CLAUDE.md", "TESTING_LINKEDIN_AUTOPILOT_FIX.md"];

const SKIP_FILES = new Set([
  path.join(ROOT, "docs/PAPR_WORKSPACE_PATHS.md"),
  path.join(ROOT, "docs/ORGANIZATION_NAMESPACE_SELECTOR.md"),
]);

/** Order matters — longer / more specific patterns first. */
const REPLACEMENTS = [
  [/~\/Papr\/apps\//g, "$PAPR_HOME/apps/"],
  [/~\/Papr\/Jobs\//g, "$PAPR_HOME/Jobs/"],
  [/~\/Papr\/jobs\//g, "$PAPR_HOME/Jobs/"],
  [/~\/Papr\/data\//g, "$PAPR_HOME/data/"],
  [/~\/Papr\/workspace\//g, "$PAPR_HOME/workspace/"],
  [/~\/Papr\/documents\//g, "$PAPR_HOME/documents/"],
  [/~\/Papr\/bundles\//g, "$PAPR_HOME/bundles/"],
  [/([^$\w])~\/Papr\/apps([^/\w]|$)/g, "$1$PAPR_HOME/apps$2"],
  [/([^$\w])~\/Papr\/Jobs([^/\w]|$)/g, "$1$PAPR_HOME/Jobs$2"],
  [/([^$\w])~\/Papr\/jobs([^/\w]|$)/g, "$1$PAPR_HOME/Jobs$2"],
  [/([^$\w])~\/Papr\/data([^/\w]|$)/g, "$1$PAPR_HOME/data$2"],
  [/`~\/Papr\/apps`/g, "`$PAPR_HOME/apps`"],
  [/`~\/Papr\/Jobs`/g, "`$PAPR_HOME/Jobs`"],
  [/`~\/Papr\/jobs`/g, "`$PAPR_HOME/Jobs`"],
  [/`~\/Papr\/data`/g, "`$PAPR_HOME/data`"],
  [/~\/Papr\/skills-catalog\.json/g, "$PAPR_HOME/skills-catalog.json"],
  [/"~\/Papr\/skills-catalog\.json"/g, '"$PAPR_HOME/skills-catalog.json"'],
  [/~\/Papr\/databases\//g, "$PAPR_HOME/databases/"],
  [/~\/Papr\/Chats\//g, "$PAPR_HOME/Chats/"],
  // stripe-project lives at Papr base (~/Papr/stripe-project), not under org/namespace — do not rewrite
  [/Mini-app\/job edits under ~\/Papr\//g, "Mini-app/job edits under $PAPR_HOME/"],
  [/under ~\/Papr\//g, "under $PAPR_HOME/"],
  [/in ~\/Papr\//g, "in $PAPR_HOME/"],
  [/from ~\/Papr\//g, "from $PAPR_HOME/"],
  [/to ~\/Papr\//g, "to $PAPR_HOME/"],
  [/No apps in ~\/Papr\/apps\./g, "No apps in active workspace ($PAPR_HOME/apps)."],
];

const FOOTER = "";

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "legacy-notes") {
        continue;
      }
      await walk(full, out);
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function applyReplacements(content) {
  let next = content;
  for (const [pattern, replacement] of REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

async function main() {
  const files = [];
  for (const rel of DOC_GLOBS) {
    await walk(path.join(ROOT, rel), files);
  }
  for (const name of ROOT_MD_FILES) {
    files.push(path.join(ROOT, name));
  }

  let changed = 0;
  for (const file of files) {
    if (SKIP_FILES.has(file)) {
      continue;
    }
    const before = await fs.readFile(file, "utf8");
    let after = applyReplacements(before);
    if (after === before) {
      continue;
    }
    if (!after.includes("PAPR_WORKSPACE_PATHS.md") && file.includes("agent-docs")) {
      const intro = `> **Paths:** \`$PAPR_HOME\` = active org/namespace workspace (\`~/Papr/orgs/{orgId}/namespaces/{nsId}/\`). See \`docs/PAPR_WORKSPACE_PATHS.md\`. Prefer app/job tools over raw paths.\n\n`;
      if (!before.startsWith("> **Paths:**")) {
        after = intro + after;
      }
    }
    await fs.writeFile(file, after, "utf8");
    changed++;
    console.log("updated:", path.relative(ROOT, file));
  }
  console.log(`\nDone. ${changed} file(s) updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
