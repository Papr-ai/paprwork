export function formatChangeRequestWhen(iso: string | undefined): string | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  const diffMs = Date.now() - ms;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
