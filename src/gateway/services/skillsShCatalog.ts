import type { CatalogSkill } from "./SkillService.js";

const SKILLS_SH_BASE = "https://skills.sh";

interface LegacySearchSkill {
  id: string;
  skillId?: string;
  name: string;
  installs?: number;
  source?: string;
}

interface V1Skill {
  id: string;
  slug?: string;
  name: string;
  source?: string;
  installs?: number;
  url?: string;
  description?: string;
}

interface V1ListResponse {
  data?: V1Skill[];
  pagination?: { hasMore?: boolean };
}

interface V1DetailResponse {
  id: string;
  files?: Array<{ path: string; contents: string }> | null;
}

function titleCaseFromSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapLegacySkill(row: LegacySearchSkill): CatalogSkill | null {
  if (!row.id || !row.name) {
    return null;
  }
  const slug = row.skillId ?? row.name;
  return {
    id: row.id,
    name: titleCaseFromSlug(slug),
    description: `Skill from ${row.source ?? "skills.sh"}`,
    content: "",
    source: "skills.sh",
    url: `${SKILLS_SH_BASE}/${row.id}`,
    installs: row.installs,
  };
}

function mapV1Skill(row: V1Skill): CatalogSkill | null {
  if (!row.id || !row.name) {
    return null;
  }
  return {
    id: row.id,
    name: titleCaseFromSlug(row.name),
    description: row.description ?? `Skill from ${row.source ?? "skills.sh"}`,
    content: "",
    source: "skills.sh",
    url: row.url ?? `${SKILLS_SH_BASE}/${row.id}`,
    installs: row.installs,
  };
}

function dedupeCatalogSkills(skills: CatalogSkill[]): CatalogSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.source}:${skill.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function fetchSkillsShLegacySearch(
  query: string,
  limit = 50,
): Promise<CatalogSkill[]> {
  const url = new URL(`${SKILLS_SH_BASE}/api/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { skills?: LegacySearchSkill[] };
    const rows = payload.skills ?? [];
    return rows
      .map(mapLegacySkill)
      .filter((skill): skill is CatalogSkill => skill !== null);
  } catch {
    return [];
  }
}

/** Broad legacy search sweep — no auth required; used when v1 API token is absent. */
export async function fetchSkillsShLegacyCatalog(
  seedQueries: string[],
  limitPerQuery = 50,
): Promise<CatalogSkill[]> {
  const batches = await Promise.all(
    seedQueries.map((query) => fetchSkillsShLegacySearch(query, limitPerQuery)),
  );
  const merged = dedupeCatalogSkills(batches.flat());
  return merged.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
}

export async function fetchSkillsShV1Page(
  token: string,
  page: number,
  perPage: number,
): Promise<CatalogSkill[]> {
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
    return [];
  }

  const payload = (await response.json()) as V1ListResponse;
  const rows = payload.data ?? [];
  return rows
    .map(mapV1Skill)
    .filter((skill): skill is CatalogSkill => skill !== null);
}

export async function fetchSkillsShV1Catalog(
  token: string,
  maxPages = 5,
  perPage = 100,
): Promise<CatalogSkill[]> {
  const all: CatalogSkill[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchSkillsShV1Page(token, page, perPage);
    if (batch.length === 0) {
      break;
    }
    all.push(...batch);
    if (batch.length < perPage) {
      break;
    }
  }
  return dedupeCatalogSkills(all);
}

export async function fetchSkillsShSkillContent(
  token: string,
  catalogId: string,
): Promise<string | null> {
  const response = await fetch(
    `${SKILLS_SH_BASE}/api/v1/skills/${catalogId}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as V1DetailResponse;
  const files = payload.files ?? [];
  const skillMd =
    files.find((file) => file.path === "SKILL.md") ??
    files.find((file) => file.path.endsWith("SKILL.md"));
  return skillMd?.contents?.trim() ?? null;
}

export const SKILLS_SH_LEGACY_SEED_QUERIES = [
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
] as const;
