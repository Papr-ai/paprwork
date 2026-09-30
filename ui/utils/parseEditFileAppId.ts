import { parseMiniAppIdFromAgentPath } from "../../src/core/utils/parseMiniAppIdFromPath.js";

/**
 * Extract mini-app id from an edit_file path (legacy or org/namespace layout).
 */
export function parseAppIdFromEditFilePath(rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
  return parseMiniAppIdFromAgentPath(rawPath);
}
