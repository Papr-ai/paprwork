#!/usr/bin/env node
/**
 * Refresh src/resources/skills-catalog.json from skills.sh.
 *
 * Uses the authenticated v1 API when VERCEL_OIDC_TOKEN is set (vercel env pull),
 * otherwise falls back to the public legacy /api/search endpoint.
 *
 * Usage:
 *   node scripts/update-skills-catalog.mjs
 *   VERCEL_OIDC_TOKEN=... node scripts/update-skills-catalog.mjs --max-pages 20
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(
  __dirname,
  "../src/resources/skills-catalog.json",
);

const SKILLS_SH_BASE = "https://skills.sh";

const LEGACY_SEED_QUERIES = [
  "react",
  "design",
  "python",
  "node",
  "api",
  "test",
  "data",
  "web",
  "sql",
  "marketing",
  "seo",
  "docker",
  "mobile",
  "typescript",
  "security",
  "debug",
  "docs",
  "stripe",
  "auth",
  "next",
  "agent",
  "code",
  "review",
  "deploy",
  "frontend",
  "backend",
  "excel",
  "pdf",
  "git",
  "graphql",
];

function titleCaseFromSlug(value) {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferCategory(name, source) {
  const text = `${name} ${source}`.toLowerCase();
  if (text.includes("react") || text.includes("frontend") || text.includes("ui"))
    return "frontend";
  if (text.includes("design") || text.includes("ux")) return "design";
  if (text.includes("test") || text.includes("qa")) return "testing";
  if (text.includes("marketing") || text.includes("seo") || text.includes("copy"))
    return "marketing";
  if (text.includes("data") || text.includes("sql") || text.includes("scrap"))
    return "data";
  if (text.includes("python") || text.includes("node") || text.includes("api"))
    return "backend";
  if (text.includes("doc") || text.includes("pdf") || text.includes("pptx"))
    return "documents";
  if (text.includes("stripe") || text.includes("payment")) return "business";
  if (text.includes("debug") || text.includes("git")) return "development";
  return "meta";
}

async function fetchLegacySearch(query, limit = 50) {
  const url = new URL(`${SKILLS_SH_BASE}/api/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json();
  return payload.skills ?? [];
}

async function fetchV1Page(token, page, perPage) {
  const url = new URL(`${SKILLS_SH_BASE}/api/v1/skills`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`skills.sh v1 page ${page} failed (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload = await response.json();
  return payload.data ?? [];
}

function mapSkillsShEntry(row) {
  const id = row.id;
  const slug = row.skillId ?? row.slug ?? row.name;
  const name = titleCaseFromSlug(slug);
  const source = row.source ?? id.split("/").slice(0, 2).join("/");
  return {
    id,
    name,
    description: row.description ?? `Popular skill from ${source}`,
    category: inferCategory(name, source),
    tags: slug.split("-").filter((part) => part.length > 2).slice(0, 4),
    source: "skills.sh",
    installs: row.installs ?? 0,
  };
}

async function fetchLegacyCatalog() {
  const byId = new Map();
  for (const query of LEGACY_SEED_QUERIES) {
    const rows = await fetchLegacySearch(query, 50);
    for (const row of rows) {
      if (!row.id) continue;
      const existing = byId.get(row.id);
      if (!existing || (row.installs ?? 0) > (existing.installs ?? 0)) {
        byId.set(row.id, mapSkillsShEntry(row));
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return [...byId.values()].sort((a, b) => b.installs - a.installs);
}

async function fetchV1Catalog(token, maxPages, perPage) {
  const byId = new Map();
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchV1Page(token, page, perPage);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.id) continue;
      byId.set(row.id, mapSkillsShEntry(row));
    }
    process.stdout.write(".");
    if (rows.length < perPage) break;
  }
  process.stdout.write("\n");
  return [...byId.values()].sort((a, b) => b.installs - a.installs);
}

function parseGtmskillsFrontmatter(raw) {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  let name = "";
  let description = "";
  let category = "";
  for (const line of fmMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "title") name = value;
    else if (key === "name" && !name) name = value;
    else if (key === "description") description = value;
    else if (key === "category") category = value;
  }
  if (!name) return null;
  return { name, description, category: category || undefined };
}

async function fetchGtmskillsCatalog() {
  const response = await fetch(
    "https://api.github.com/repos/swan-gtm/gtm-skills/git/trees/main?recursive=1",
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`gtmskills GitHub tree failed (${response.status})`);
  }
  const payload = await response.json();
  const skillPaths = (payload.tree ?? [])
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path.endsWith("/SKILL.md") &&
        !entry.path.includes("/.system/"),
    )
    .map((entry) => entry.path.replace(/\/SKILL\.md$/, ""));

  const results = [];
  const batchSize = 25;
  for (let i = 0; i < skillPaths.length; i += batchSize) {
    const batch = skillPaths.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map(async (skillPath) => {
        const rawResponse = await fetch(
          `https://raw.githubusercontent.com/swan-gtm/gtm-skills/main/${skillPath}/SKILL.md`,
        );
        if (!rawResponse.ok) return null;
        const raw = await rawResponse.text();
        const meta = parseGtmskillsFrontmatter(raw);
        const slug = skillPath.split("/").pop() ?? skillPath;
        return {
          id: skillPath,
          name: meta?.name ?? titleCaseFromSlug(slug),
          description:
            meta?.description ??
            `Verified GTM skill from gtmskills.com (${skillPath})`,
          category: inferCategory(meta?.name ?? slug, meta?.category ?? "gtm"),
          tags: [meta?.category?.toLowerCase() ?? "gtm", slug],
          source: "gtmskills.com",
        };
      }),
    );
    results.push(...fetched.filter(Boolean));
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return results;
}

async function fetchGtmSkillsComPrompts() {
  const all = [];
  const pageSize = 100;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://gtm-skills.com/api/v1/prompts");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) break;
    const payload = await response.json();
    const rows = payload.data ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      all.push({
        id: `prompt/${row.id}`,
        name: row.title,
        description: row.description ?? "GTM sales prompt from gtm-skills.com",
        category: inferCategory(row.title, `${row.category ?? ""} ${row.subcategory ?? ""}`),
        tags: row.tags ?? ["gtm", "prompt"],
        source: "gtm-skills.com",
      });
    }
    if (!payload.pagination?.hasMore) break;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return all;
}

async function fetchGtmOpenClawSkills() {
  const paths = [
    "openclaw-skills/scout",
    "openclaw-skills/writer",
    "openclaw-skills/rep",
    "openclaw-skills/closer",
    "openclaw-skills/mission-control",
  ];
  const results = [];
  for (const skillPath of paths) {
    const response = await fetch(
      `https://raw.githubusercontent.com/gtm-skills/gtm/main/${skillPath}/SKILL.md`,
    );
    if (!response.ok) continue;
    const raw = await response.text();
    const slug = skillPath.split("/").pop() ?? skillPath;
    results.push({
      id: skillPath,
      name: titleCaseFromSlug(slug),
      description: `OpenClaw GTM agent skill from github.com/gtm-skills/gtm (${slug})`,
      category: "business",
      tags: ["gtm", "openclaw", slug],
      source: "gtm-skills.com",
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const maxPagesArg = args.find((arg) => arg.startsWith("--max-pages="));
  const maxPages = maxPagesArg ? Number(maxPagesArg.split("=")[1]) : 10;
  const perPage = 100;

  const existingRaw = await readFile(catalogPath, "utf8");
  const existing = JSON.parse(existingRaw);
  const clawhubSkills = (existing.skills ?? []).filter(
    (skill) => skill.source === "clawhub",
  );

  const token = process.env.VERCEL_OIDC_TOKEN;
  let skillsShSkills;
  if (token) {
    console.log(`Fetching skills.sh v1 leaderboard (max ${maxPages} pages)...`);
    skillsShSkills = await fetchV1Catalog(token, maxPages, perPage);
  } else {
    console.log(
      "No VERCEL_OIDC_TOKEN — using legacy /api/search sweep (set token for full catalog).",
    );
    skillsShSkills = await fetchLegacyCatalog();
  }

  const topSkillsSh = skillsShSkills.slice(0, 200);

  console.log("Fetching gtmskills.com from swan-gtm/gtm-skills...");
  const gtmskills = await fetchGtmskillsCatalog();
  console.log("Fetching gtm-skills.com prompts API...");
  const gtmPrompts = await fetchGtmSkillsComPrompts();
  console.log("Fetching gtm-skills/gtm OpenClaw agent skills...");
  const gtmOpenClaw = await fetchGtmOpenClawSkills();

  const output = {
    _meta: {
      description:
        "Cached catalog of popular skills from skills.sh, ClawHub, gtmskills.com, and gtm-skills.com. Agent reads this file during onboarding instead of browsing the web.",
      lastUpdated: new Date().toISOString().slice(0, 10),
      sources: [
        "skills.sh",
        "clawhub.ai",
        "gtmskills.com",
        "gtm-skills.com",
        "github.com/gtm-skills/gtm",
      ],
      skillsShCount: topSkillsSh.length,
      clawhubCount: clawhubSkills.length,
      gtmskillsCount: gtmskills.length,
      gtmSkillsComCount: gtmPrompts.length + gtmOpenClaw.length,
      fetchMode: token ? "v1-authenticated" : "legacy-search",
    },
    skills: [
      ...topSkillsSh,
      ...clawhubSkills,
      ...gtmskills,
      ...gtmOpenClaw,
      ...gtmPrompts,
    ],
  };

  await writeFile(catalogPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(
    `Updated ${catalogPath}: ${topSkillsSh.length} skills.sh + ${clawhubSkills.length} clawhub + ${gtmskills.length} gtmskills.com + ${gtmPrompts.length + gtmOpenClaw.length} gtm-skills.com (${output.skills.length} total)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
