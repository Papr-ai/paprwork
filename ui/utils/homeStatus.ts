/**
 * One-line card status for the Apps redesign cards (My apps home + sections).
 * Schedule + last run, on-demand automations, failures, unnamed, draft.
 */
import type { Artifact } from "../stores/artifactsStore";
import type { AppHealth } from "../../src/core/utils/appsHealth";
import { appStatusLine } from "./appStatusLine";
import { isIdLikeTitle } from "./appsLibrary";

export interface HomeStatus {
  text: string;
  bad: boolean;
}

function shortAgo(iso?: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

export function homeStatus(a: Artifact, h: AppHealth | undefined, isPublished: boolean): HomeStatus | null {
  if ((a.status ?? "active") === "archived") return { text: "Archived", bad: false };
  if (isIdLikeTitle(a.title)) return { text: "Needs a name", bad: true };
  const line = appStatusLine(a, { health: h, isPublished });
  if (h?.state === "failed") {
    const head = line.text.split(":")[0] ?? "";
    return { text: h.scheduleLabel ? head : `Automation ${head}`, bad: true };
  }
  if (line.text) return { text: line.text, bad: false };
  if (h && h.jobCount > 0) {
    if (h.state === "running") return { text: "Running now", bad: false };
    const ago = shortAgo(h.lastRunAt);
    return { text: ago ? `Runs on demand · last run ${ago}` : "Runs on demand · hasn't run yet", bad: false };
  }
  if (a.status === "draft" && !isPublished) return { text: "Draft", bad: false };
  return null;
}
