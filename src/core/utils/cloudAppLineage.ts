import type { CloudAppLineageFile } from "../types/cloudAppLineage.js";

export function serializeCloudAppLineageFile(
  lineage: CloudAppLineageFile,
): string {
  return `${JSON.stringify(lineage, null, 2)}\n`;
}

export function parseCloudAppLineageFile(raw: string): CloudAppLineageFile | null {
  try {
    const parsed = JSON.parse(raw) as CloudAppLineageFile;
    if (
      (parsed.schemaVersion !== "1.0.0" && parsed.schemaVersion !== "1.1.0") ||
      !parsed.lineageId ||
      !parsed.source
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
