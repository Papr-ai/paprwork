/** Sender caps, shared by route() and the source mapping. */
import type { NoticeInput, NoticeLevel } from "../types/notices.js";

/** Only Papr itself (platform, billing) may say Urgent. Apps, jobs and agents top out at Priority. */
export function effectiveLevel(n: NoticeInput): NoticeLevel {
  const trusted = n.source.type === "platform" || n.source.type === "billing";
  return n.level === "urgent" && !trusted ? "priority" : n.level;
}
