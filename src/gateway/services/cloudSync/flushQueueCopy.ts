/**
 * Human-readable copy for namespace app flush queue position.
 */

export function flushQueueAppsAhead(position: number): number {
  return position > 1 ? position - 1 : 0;
}

export function formatFlushQueueLabel(
  position: number,
  depth: number,
): string {
  if (depth <= 1) {
    return "Queued for upload…";
  }
  const ahead = flushQueueAppsAhead(position);
  if (ahead === 0) {
    return "Next in upload queue";
  }
  const queueSuffix = depth > 1 ? ` · ${depth} in queue` : "";
  return `${ahead} app${ahead === 1 ? "" : "s"} ahead${queueSuffix}`;
}

export function formatFlushQueueDetail(
  position: number,
  depth: number,
): string {
  const ahead = flushQueueAppsAhead(position);
  if (ahead === 0) {
    return "Next in line — upload starting soon.";
  }
  const queueNote = depth > 1 ? ` (${depth} apps in queue).` : ".";
  return `${ahead} other app${ahead === 1 ? "" : "s"} uploading first${queueNote} Use Upload now or Move to front to skip the line.`;
}
