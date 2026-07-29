import { promises as fs } from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  assignedAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  source?: "local" | "preloaded" | "clawhub" | "skills.sh";
  externalId?: string;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  source: "clawhub" | "skills.sh";
  url?: string;
  category?: string;
  tags?: string[];
  installs?: number;
}

interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  source?: SkillRecord["source"];
  externalId?: string;
}

interface InstallCatalogSkillInput {
  source: "clawhub" | "skills.sh";
  catalogId: string;
}

interface PreloadedSkillDef {
  id: string;
  name: string;
  description: string;
  content: string;
}

/** Parse simple YAML-like frontmatter from a markdown file */
function parseSkillFrontmatter(raw: string): PreloadedSkillDef | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return null;
  }
  const fmBlock = fmMatch[1];
  const content = fmMatch[2].trim();

  let id = "";
  let name = "";
  let description = "";

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "id") id = value;
    else if (key === "name") name = value;
    else if (key === "description") description = value;
  }

  if (!id || !name || !content) {
    return null;
  }
  return { id, name, description, content };
}

let skillServiceInstance: SkillService | null = null;

export class SkillService {
  private paprRootDir: string;
  private skillIndexPath: string;
  private skills: Map<string, SkillRecord>;
  private initialized: boolean;

  constructor() {
    this.paprRootDir = getPaprRoot();
    this.skillIndexPath = path.join(this.paprRootDir, "data", "skills.json");
    this.skills = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(path.dirname(this.skillIndexPath), { recursive: true });
    await this.load();
    await this.ensurePreloadedSkills();
    await this.ensureCatalogCached();
    this.initialized = true;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.skillIndexPath, "utf8");
      const list = JSON.parse(raw) as SkillRecord[];
      const normalized = list.map((skill) => ({
        ...skill,
        enabled: skill.enabled ?? true,
        assignedAgentIds: Array.isArray(skill.assignedAgentIds)
          ? skill.assignedAgentIds
          : [],
      }));
      this.skills = new Map(normalized.map((skill) => [skill.id, skill]));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.error("[SkillService] Failed to load skills:", error);
      }
      this.skills = new Map();
    }
  }

  private async save(): Promise<void> {
    const list = Array.from(this.skills.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    await fs.writeFile(
      this.skillIndexPath,
      JSON.stringify(list, null, 2),
      "utf8",
    );
  }

  private async loadPreloadedSkillDefs(): Promise<PreloadedSkillDef[]> {
    const defs: PreloadedSkillDef[] = [];

    // Resolve skill files relative to this source file's location
    // In dev: src/gateway/services/ -> src/resources/skills/
    // In prod: the compiled output mirrors the same relative structure
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const skillsDir = path.resolve(thisDir, "../../resources/skills");

    try {
      const files = await fs.readdir(skillsDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        try {
          const raw = await fs.readFile(path.join(skillsDir, file), "utf8");
          const parsed = parseSkillFrontmatter(raw);
          if (parsed) {
            defs.push(parsed);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      console.warn(
        "[SkillService] Could not read preloaded skills directory:",
        skillsDir,
      );
    }
    return defs;
  }

  private async ensurePreloadedSkills(): Promise<void> {
    const defs = await this.loadPreloadedSkillDefs();
    let changed = false;
    const now = new Date().toISOString();
    for (const baseSkill of defs) {
      const existing = this.skills.get(baseSkill.id);
      if (existing) {
        // Update content if the bundled skill has changed
        if (
          existing.source === "preloaded" &&
          existing.content !== baseSkill.content
        ) {
          this.skills.set(baseSkill.id, {
            ...existing,
            name: baseSkill.name,
            description: baseSkill.description,
            content: baseSkill.content,
            updatedAt: now,
          });
          changed = true;
        }
        continue;
      }
      this.skills.set(baseSkill.id, {
        ...baseSkill,
        enabled: true,
        assignedAgentIds: [],
        createdAt: now,
        updatedAt: now,
        source: "preloaded",
      });
      changed = true;
    }
    if (changed) {
      await this.save();
    }
  }

  /**
   * Copy the bundled skills-catalog.json to ~/Papr/skills-catalog.json
   * so the agent can read it with read_file during onboarding.
   */
  private async ensureCatalogCached(): Promise<void> {
    const destPath = path.join(this.paprRootDir, "skills-catalog.json");
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const srcPath = path.resolve(
      thisDir,
      "../../resources/skills-catalog.json",
    );

    try {
      await fs.copyFile(srcPath, destPath);
      console.log("[SkillService] Cached skills catalog →", destPath);
    } catch {
      console.warn(
        "[SkillService] Could not cache skills catalog from:",
        srcPath,
      );
    }
  }

  private parseCatalogResponse(
    source: "clawhub" | "skills.sh",
    payload: unknown,
  ): CatalogSkill[] {
    const list: unknown[] = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && "skills" in payload
        ? (((payload as { skills?: unknown }).skills as unknown[]) ?? [])
        : [];

    const result: CatalogSkill[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : null;
      const name = typeof row.name === "string" ? row.name : null;
      const description =
        typeof row.description === "string" ? row.description : "";
      const content =
        typeof row.content === "string"
          ? row.content
          : typeof row.instructions === "string"
            ? row.instructions
            : "";
      const url = typeof row.url === "string" ? row.url : undefined;
      if (!id || !name || !content) {
        continue;
      }
      result.push({
        id,
        name,
        description,
        content,
        source,
        url,
      });
    }
    return result;
  }

  private async fetchCatalog(
    source: "clawhub" | "skills.sh",
    url: string,
  ): Promise<CatalogSkill[]> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return [];
      }
      const payload = (await response.json()) as unknown;
      return this.parseCatalogResponse(source, payload);
    } catch {
      return [];
    }
  }

  async listCatalogSkills(): Promise<CatalogSkill[]> {
    // Try live APIs first
    const clawhubUrl = process.env.CLAWHUB_SKILLS_CATALOG_URL;
    const skillsShUrl = process.env.SKILLS_SH_CATALOG_URL;

    const [clawhub, skillsSh] = await Promise.all([
      clawhubUrl
        ? this.fetchCatalog("clawhub", clawhubUrl)
        : Promise.resolve([]),
      skillsShUrl
        ? this.fetchCatalog("skills.sh", skillsShUrl)
        : Promise.resolve([]),
    ]);

    let merged = [...clawhub, ...skillsSh];

    // Fall back to cached catalog if live APIs returned nothing
    if (merged.length === 0) {
      merged = await this.loadCachedCatalog();
    }

    const seen = new Set<string>();
    return merged.filter((skill) => {
      const key = `${skill.source}:${skill.id}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Load the cached skills-catalog.json from ~/Papr or the bundled resource.
   */
  private async loadCachedCatalog(): Promise<CatalogSkill[]> {
    // Try user-data copy first, then bundled resource
    const userCopy = path.join(this.paprRootDir, "skills-catalog.json");
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const bundledCopy = path.resolve(
      thisDir,
      "../../resources/skills-catalog.json",
    );

    for (const filePath of [userCopy, bundledCopy]) {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { skills?: unknown[] };
        const entries = parsed.skills ?? [];
        const result: CatalogSkill[] = [];
        for (const entry of entries) {
          if (typeof entry !== "object" || entry === null) continue;
          const row = entry as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : null;
          const name = typeof row.name === "string" ? row.name : null;
          const description =
            typeof row.description === "string" ? row.description : "";
          const source =
            row.source === "clawhub"
              ? ("clawhub" as const)
              : ("skills.sh" as const);
          const category =
            typeof row.category === "string" ? row.category : undefined;
          const tags = Array.isArray(row.tags)
            ? (row.tags as string[])
            : undefined;
          const installs =
            typeof row.installs === "number" ? row.installs : undefined;
          if (!id || !name) continue;
          result.push({
            id,
            name,
            description,
            content: "", // Catalog entries don't include full content; fetched on install
            source,
            category,
            tags,
            installs,
          });
        }
        if (result.length > 0) {
          console.log(
            `[SkillService] Loaded ${result.length} catalog skills from cache: ${filePath}`,
          );
          return result;
        }
      } catch {
        // Try next source
      }
    }
    return [];
  }

  async listSkills(): Promise<SkillRecord[]> {
    return Array.from(this.skills.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getSkill(skillId: string): Promise<SkillRecord | null> {
    return this.skills.get(skillId) ?? null;
  }

  async createSkill(input: CreateSkillInput): Promise<SkillRecord> {
    const now = new Date().toISOString();
    const skill: SkillRecord = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      content: input.content,
      enabled: true,
      assignedAgentIds: [],
      createdAt: now,
      updatedAt: now,
      source: input.source ?? "local",
      externalId: input.externalId,
    };
    this.skills.set(skill.id, skill);
    await this.save();
    return skill;
  }

  async updateSkill(
    skillId: string,
    updates: Partial<
      Pick<
        SkillRecord,
        "name" | "description" | "content" | "enabled" | "assignedAgentIds"
      >
    >,
  ): Promise<SkillRecord | null> {
    const current = this.skills.get(skillId);
    if (!current) {
      return null;
    }
    const next: SkillRecord = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.skills.set(skillId, next);
    await this.save();
    return next;
  }

  async deleteSkill(skillId: string): Promise<boolean> {
    const deleted = this.skills.delete(skillId);
    if (deleted) {
      await this.save();
    }
    return deleted;
  }

  async setEnabled(
    skillId: string,
    enabled: boolean,
  ): Promise<SkillRecord | null> {
    return this.updateSkill(skillId, { enabled });
  }

  async setAgentAccess(
    skillId: string,
    agentIds: string[],
  ): Promise<SkillRecord | null> {
    const deduped = Array.from(
      new Set(
        agentIds.map((item) => item.trim()).filter((item) => item.length > 0),
      ),
    );
    return this.updateSkill(skillId, { assignedAgentIds: deduped });
  }

  async installCatalogSkill(
    input: InstallCatalogSkillInput,
  ): Promise<SkillRecord> {
    const catalog = await this.listCatalogSkills();
    const match = catalog.find(
      (skill) => skill.source === input.source && skill.id === input.catalogId,
    );
    if (!match) {
      throw new Error(
        `Catalog skill not found: ${input.source}/${input.catalogId}`,
      );
    }

    const existing = Array.from(this.skills.values()).find(
      (skill) => skill.externalId === match.id && skill.source === match.source,
    );
    if (existing) {
      return existing;
    }

    return this.createSkill({
      name: match.name,
      description: match.description,
      content: match.content,
      source: match.source,
      externalId: match.id,
    });
  }
}

export function getSkillService(): SkillService {
  if (!skillServiceInstance) {
    skillServiceInstance = new SkillService();
  }
  return skillServiceInstance;
}

export async function initializeSkillService(): Promise<SkillService> {
  const service = getSkillService();
  await service.initialize();
  return service;
}

/** Reset singleton after org/namespace workspace switch. */
export function resetSkillServiceForWorkspaceSwitch(): void {
  skillServiceInstance = null;
}
