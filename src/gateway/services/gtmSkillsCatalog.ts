import type { CatalogSkill } from "./SkillService.js";

const GTM_SKILLS_API = "https://gtm-skills.com/api/v1/prompts";
const GTMSKILLS_GITHUB_RAW =
  "https://raw.githubusercontent.com/swan-gtm/gtm-skills/main";
const GTM_REPO_GITHUB_RAW =
  "https://raw.githubusercontent.com/gtm-skills/gtm/main";

const OPENCLAW_SKILL_IDS = [
  "openclaw-skills/scout",
  "openclaw-skills/writer",
  "openclaw-skills/rep",
  "openclaw-skills/closer",
  "openclaw-skills/mission-control",
] as const;

interface GtmPromptRow {
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  category?: string;
  subcategory?: string;
  tags?: string[];
  url?: string;
}

interface GtmPromptListResponse {
  data?: GtmPromptRow[];
  pagination?: { hasMore?: boolean; total?: number };
}

interface GitHubTreeResponse {
  tree?: Array<{ path: string; type: string }>;
}

function titleCase(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapGtmCategory(category?: string, subcategory?: string): string {
  const text = `${category ?? ""} ${subcategory ?? ""}`.toLowerCase();
  if (text.includes("outreach") || text.includes("prospect")) return "marketing";
  if (text.includes("discovery") || text.includes("deal")) return "business";
  if (text.includes("objection") || text.includes("close")) return "business";
  if (text.includes("revops") || text.includes("ops")) return "data";
  return "business";
}

function mapGtmskillsCategory(category?: string): string {
  const text = (category ?? "").toLowerCase();
  if (text.includes("prospect") || text.includes("outreach")) return "marketing";
  if (text.includes("abm") || text.includes("deal")) return "business";
  if (text.includes("seo") || text.includes("content")) return "marketing";
  if (text.includes("ads")) return "marketing";
  if (text.includes("signal")) return "data";
  return "business";
}

export function parseGtmskillsFrontmatter(raw: string): {
  name: string;
  description: string;
  category?: string;
} | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return null;
  }

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

  if (!name) {
    return null;
  }
  return { name, description, category: category || undefined };
}

function mapGtmPrompt(row: GtmPromptRow): CatalogSkill {
  return {
    id: `prompt/${row.id}`,
    name: row.title,
    description: row.description ?? "GTM sales prompt from gtm-skills.com",
    content: row.prompt ?? "",
    source: "gtm-skills.com",
    url: row.url ?? `https://gtm-skills.com/prompts/${row.id}`,
    category: mapGtmCategory(row.category, row.subcategory),
    tags: row.tags,
  };
}

function mapOpenClawSkill(skillPath: string, content: string): CatalogSkill | null {
  const parsed = parseSkillFrontmatter(content);
  const slug = skillPath.split("/").pop() ?? skillPath;
  const name = parsed?.name ?? titleCase(slug);
  const description =
    parsed?.description ??
    `OpenClaw GTM agent skill from github.com/gtm-skills/gtm (${slug})`;

  return {
    id: skillPath,
    name,
    description,
    content,
    source: "gtm-skills.com",
    url: `https://github.com/gtm-skills/gtm/tree/main/${skillPath}`,
    category: "business",
    tags: ["gtm", "openclaw", slug],
  };
}

function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return null;
  }

  let name = "";
  let description = "";
  for (const line of fmMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") name = value.replace(/^["']|["']$/g, "");
    else if (key === "description") description = value.replace(/^["']|["']$/g, "");
  }

  if (!name) {
    return null;
  }
  return { name, description };
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

export async function fetchGtmSkillsComPromptCatalog(
  maxPages = 5,
  pageSize = 100,
): Promise<CatalogSkill[]> {
  const all: CatalogSkill[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(GTM_SKILLS_API);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));

    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        break;
      }
      const payload = (await response.json()) as GtmPromptListResponse;
      const rows = payload.data ?? [];
      if (rows.length === 0) {
        break;
      }
      all.push(...rows.map(mapGtmPrompt));
      if (!payload.pagination?.hasMore) {
        break;
      }
    } catch {
      break;
    }
  }

  return all;
}

export async function fetchGtmSkillsComOpenClawCatalog(): Promise<CatalogSkill[]> {
  const results: CatalogSkill[] = [];
  for (const skillPath of OPENCLAW_SKILL_IDS) {
    const content = await fetchText(`${GTM_REPO_GITHUB_RAW}/${skillPath}/SKILL.md`);
    if (!content) {
      continue;
    }
    const mapped = mapOpenClawSkill(skillPath, content);
    if (mapped) {
      results.push(mapped);
    }
  }
  return results;
}

export async function fetchGtmskillsComCatalogFromGitHub(
  maxSkills = 400,
): Promise<CatalogSkill[]> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/swan-gtm/gtm-skills/git/trees/main?recursive=1",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as GitHubTreeResponse;
    const skillPaths = (payload.tree ?? [])
      .filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.endsWith("/SKILL.md") &&
          !entry.path.includes("/.system/"),
      )
      .map((entry) => entry.path.replace(/\/SKILL\.md$/, ""))
      .slice(0, maxSkills);

    const results: CatalogSkill[] = [];
    const batchSize = 20;
    for (let i = 0; i < skillPaths.length; i += batchSize) {
      const batch = skillPaths.slice(i, i + batchSize);
      const fetched = await Promise.all(
        batch.map(async (skillPath) => {
          const raw = await fetchText(`${GTMSKILLS_GITHUB_RAW}/${skillPath}/SKILL.md`);
          if (!raw) {
            return null;
          }
          const meta = parseGtmskillsFrontmatter(raw);
          const slug = skillPath.split("/").pop() ?? skillPath;
          return {
            id: skillPath,
            name: meta?.name ?? titleCase(slug),
            description:
              meta?.description ??
              `Verified GTM skill from gtmskills.com (${skillPath})`,
            content: "",
            source: "gtmskills.com" as const,
            url: `https://www.gtmskills.com/skill/${slug}`,
            category: mapGtmskillsCategory(meta?.category),
            tags: [meta?.category?.toLowerCase() ?? "gtm", slug],
          };
        }),
      );
      for (const skill of fetched) {
        if (skill !== null) {
          results.push(skill);
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function fetchGtmSkillsComPromptContent(
  catalogId: string,
): Promise<string | null> {
  const promptId = catalogId.startsWith("prompt/")
    ? catalogId.slice("prompt/".length)
    : catalogId;
  try {
    const response = await fetch(`${GTM_SKILLS_API}/${promptId}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: GtmPromptRow };
    const row = payload.data;
    if (!row?.prompt) {
      return null;
    }
    return `# ${row.title}\n\n${row.description ?? ""}\n\n## Prompt\n\n${row.prompt}`;
  } catch {
    return null;
  }
}

export async function fetchGtmskillsComSkillContent(
  catalogId: string,
): Promise<string | null> {
  return fetchText(`${GTMSKILLS_GITHUB_RAW}/${catalogId}/SKILL.md`);
}

export async function fetchGtmSkillsComOpenClawContent(
  catalogId: string,
): Promise<string | null> {
  return fetchText(`${GTM_REPO_GITHUB_RAW}/${catalogId}/SKILL.md`);
}

export async function fetchGtmCatalogSkillsLive(): Promise<CatalogSkill[]> {
  const [prompts, openClaw, gtmskills] = await Promise.all([
    fetchGtmSkillsComPromptCatalog(),
    fetchGtmSkillsComOpenClawCatalog(),
    fetchGtmskillsComCatalogFromGitHub(),
  ]);
  return [...gtmskills, ...openClaw, ...prompts];
}
