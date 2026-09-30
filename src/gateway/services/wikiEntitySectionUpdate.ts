import fs from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { clearWikiHomeRemoteCache } from "./KnowledgeGraphWikiService.js";

export interface ToggleEntityOpenItemInput {
  type: string;
  id: string;
  itemIndex: number;
  completed: boolean;
}

function getEntitiesDir(): string {
  return path.join(getPaprWorkspaceDir(), "entities");
}

function normalizeEntityType(rawType: string): string {
  const type = rawType.toLowerCase();
  if (type === "companies") return "company";
  if (type === "people") return "person";
  if (type === "projects") return "project";
  return type;
}

function entityPlural(type: string): string {
  if (type === "company") return "companies";
  if (type === "person") return "people";
  if (type === "project") return "projects";
  return `${type}s`;
}

function resolveEntityFilePath(type: string, id: string): string {
  const normalizedType = normalizeEntityType(type);
  const slug = id.includes("/") ? id.split("/").pop()! : id;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(slug)) {
    throw new Error("Invalid entity id");
  }
  const entityPath = path.join(
    getEntitiesDir(),
    entityPlural(normalizedType),
    `${slug}.md`,
  );
  if (!fs.existsSync(entityPath)) {
    throw new Error("Entity file not found");
  }
  return entityPath;
}

function touchUpdatedAt(content: string): string {
  const now = new Date().toISOString().slice(0, 10);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return content;
  const line = /^updated_at:.*$/m;
  let yaml = frontmatter[1];
  yaml = line.test(yaml)
    ? yaml.replace(line, `updated_at: ${now}`)
    : `${yaml.trimEnd()}\nupdated_at: ${now}`;
  return content.replace(frontmatter[0], `---\n${yaml}\n---`);
}

function replaceOpenItemsSection(
  content: string,
  itemIndex: number,
  completed: boolean,
): string {
  const sectionRe = /^## Open Items\s*$/m;
  const match = sectionRe.exec(content);
  if (!match) throw new Error("Open Items section not found");

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.search(/^## /m);
  const sectionEnd = nextHeading >= 0 ? start + nextHeading : content.length;
  const sectionBody = content.slice(start, sectionEnd);

  let currentIndex = -1;
  const updatedLines = sectionBody.split("\n").map((line) => {
    const trimmed = line.trim();
    const checkbox = trimmed.match(/^([-*])\s*\[([xX ])\]\s*(.+)$/);
    if (!checkbox) return line;
    currentIndex += 1;
    if (currentIndex !== itemIndex) return line;
    const marker = completed ? "x" : " ";
    const prefix = checkbox[1];
    return `${line.match(/^\s*/)?.[0] ?? ""}${prefix} [${marker}] ${checkbox[3]}`;
  });

  if (currentIndex < itemIndex) {
    throw new Error("Open item index out of range");
  }

  const updatedSection = updatedLines.join("\n");
  const updated = `${content.slice(0, start)}${updatedSection}${content.slice(sectionEnd)}`;
  return touchUpdatedAt(updated);
}

/** Apply an open-item toggle to entity markdown (exported for tests). */
export function applyOpenItemToggleToMarkdown(
  content: string,
  itemIndex: number,
  completed: boolean,
): string {
  return replaceOpenItemsSection(content, itemIndex, completed);
}

/** Toggle a checkbox line in an entity's Open Items section. */
export function toggleEntityOpenItem(input: ToggleEntityOpenItemInput): {
  filePath: string;
} {
  const filePath = resolveEntityFilePath(input.type, input.id);
  const content = fs.readFileSync(filePath, "utf8");
  const updated = replaceOpenItemsSection(
    content,
    input.itemIndex,
    input.completed,
  );
  fs.writeFileSync(filePath, updated, "utf8");
  clearWikiHomeRemoteCache();
  return { filePath };
}
