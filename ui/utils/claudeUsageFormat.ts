export function formatClaudeUsageReset(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return "";
  }
  const diffMs = at - Date.now();
  if (diffMs <= 0) {
    return "Resets soon";
  }
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 120) {
    return `Resets in ${totalMin} min`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 48) {
    return mins > 0 ? `Resets in ${hours} hr ${mins} min` : `Resets in ${hours} hr`;
  }
  return `Resets ${new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
