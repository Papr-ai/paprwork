/**
 * Shared helpers for wiki graph node labels and rail filtering.
 */

import {
  resolveProjectIdDisplayName,
  resolveUuidToDisplayName,
} from "./storage/codeIndexMetadata.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function isUuidLikeName(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** Exclude code-index file artifacts and other non-entity rows from wiki rails. */
export function isWikiRailExcluded(
  record: Record<string, unknown>,
  wikiType: string,
): boolean {
  const source = asString(record.source);
  const entityType = asString(record.entity_type);
  const filePath = asString(record.file_path);
  const fileName = asString(record.file_name);

  if (entityType === "code_file" || entityType === "file_summary") {
    return true;
  }

  if (filePath || (fileName && wikiType === "project")) {
    return true;
  }

  if (source === "code_indexer" && (filePath || fileName)) {
    return true;
  }

  if (
    wikiType === "project" &&
    asString(record.lines_of_code) &&
    (filePath || fileName || isUuidLikeName(asString(record.name)))
  ) {
    return true;
  }

  return false;
}

export function pickWikiLabel(
  record: Record<string, unknown>,
  wikiType: string,
): string {
  const candidates = [
    record.name,
    record.project_name,
    record.title,
    record.task_name,
    record.description,
    record.content,
    record.label,
  ];

  const readable: string[] = [];
  const uuidFallback: string[] = [];

  for (const candidate of candidates) {
    const text = asString(candidate).trim();
    if (!text) continue;
    if (isUuidLikeName(text)) {
      uuidFallback.push(text);
    } else {
      readable.push(text);
    }
  }

  const chosen = readable[0] ?? uuidFallback[0];
  if (chosen) {
    let label = chosen;
    if (isUuidLikeName(label)) {
      const resolved =
        wikiType === "project"
          ? resolveProjectIdDisplayName(label, asString(record.type))
          : resolveUuidToDisplayName(label);
      if (resolved) label = resolved;
    }
    return label.length > 80 ? `${label.slice(0, 77)}…` : label;
  }

  return `${wikiType} ${asString(record.id).slice(0, 8)}`;
}
