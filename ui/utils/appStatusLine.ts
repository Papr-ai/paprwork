/**
 * One-line card status: answers "is this app working?" before it is opened.
 */
import type { Artifact } from "../stores/artifactsStore";
import type { AppHealth } from "../../src/core/utils/appsHealth";
import { isIdLikeTitle } from "./appsLibrary";

export type StatusTone = "neutral" | "ok" | "live" | "fail" | "running";

export interface AppStatusLine {
  tone: StatusTone;
  text: string;
  /** Primary card action label. */
  action: "Open" | "Fix" | "Name it" | "Restore";
}

export function formatAgo(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function appStatusLine(
  app: Artifact,
  opts: { health?: AppHealth; isPublished: boolean; now?: number },
): AppStatusLine {
  const { health, isPublished } = opts;
  const status = app.status ?? "active";
  if (status === "archived") {
    return { tone: "neutral", text: "Archived", action: "Restore" };
  }
  if (isIdLikeTitle(app.title)) {
    return {
      tone: "fail",
      text: "Unnamed app — give it a name",
      action: "Name it",
    };
  }
  const schedule = health?.scheduleLabel
    ? capitalize(health.scheduleLabel)
    : null;
  const ago = formatAgo(health?.lastRunAt, opts.now);

  if (health?.state === "failed") {
    const why = health.error ? `: ${health.error}` : "";
    const when = ago ? `failed ${ago}` : "last run failed";
    const streak =
      health.failureStreak > 1 ? ` (${health.failureStreak} in a row)` : "";
    return {
      tone: "fail",
      text: `${schedule ? `${schedule} · ` : ""}${when}${streak}${why}`,
      action: "Fix",
    };
  }
  if (health?.state === "running") {
    return {
      tone: "running",
      text: `${schedule ? `${schedule} · ` : ""}running now`,
      action: "Open",
    };
  }
  if (schedule) {
    const last =
      health?.state === "ok" && ago
        ? ` · last run ok ${ago}`
        : " · hasn't run yet";
    return { tone: "ok", text: `${schedule}${last}`, action: "Open" };
  }
  if (app.cloudLineage) {
    const src = app.cloudLineage.sourceSlug;
    return {
      tone: "neutral",
      text:
        app.cloudLineage.mode === "track"
          ? `Follows ${src}`
          : `Your copy of ${src}`,
      action: "Open",
    };
  }
  if (isPublished)
    return { tone: "live", text: "Live on the web", action: "Open" };
  if (status === "draft")
    return {
      tone: "neutral",
      text: "Draft · only you can see it",
      action: "Open",
    };
  return { tone: "neutral", text: "", action: "Open" };
}
