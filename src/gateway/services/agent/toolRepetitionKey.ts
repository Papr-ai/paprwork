/**
 * Dedup key for pi-ai tool-loop detection. Uses the full serialized args so
 * incremental edit_file patches to the same path are not treated as identical
 * when only oldString/newString differ (path prefixes can exceed 100 chars).
 */
export function toolRepetitionDedupKey(
  toolName: string,
  argsJson: string,
): string {
  return `${toolName}:${argsJson}`;
}
