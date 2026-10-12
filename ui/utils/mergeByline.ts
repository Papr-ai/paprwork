/** "Published by Shawkat · Fix chart labels · 2h ago" for the status dialog. */

export interface BylineMerge {
  actorUserId: string | null;
  title: string | null;
  publishedDirectly: boolean;
  at: string;
}

export interface BylineMember {
  userId: string;
  displayName?: string;
  email?: string;
}

function ago(iso: string, now: number): string {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min)) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

export function formatMergeByline(
  merge: BylineMerge,
  members: ReadonlyArray<BylineMember>,
  now = Date.now(),
): string {
  const who = members.find((m) => m.userId === merge.actorUserId);
  const name = who?.displayName?.trim() || who?.email?.split("@")[0] || "a Maintainer";
  const verb = merge.publishedDirectly ? "Published by" : "Accepted by";
  const title = merge.title?.trim();
  return [`${verb} ${name}`, title ? `“${title}”` : null, ago(merge.at, now)]
    .filter(Boolean)
    .join(" · ");
}
