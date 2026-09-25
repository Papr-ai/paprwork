/**
 * SVG path data for share-audience glyphs. One source for the Share button and
 * the share sheet so the same audience always reads the same at a glance.
 */

import type { ShareAudience } from "./shareAudienceModel";

export function shareAudienceGlyphPath(audience: ShareAudience): string {
  switch (audience) {
    case "public":
      return "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c1.7 1.8 2.6 4.1 2.6 6.5S9.7 12.7 8 14.5c-1.7-1.8-2.6-4.1-2.6-6.5S6.3 3.3 8 1.5Z";
    case "team":
      return "M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.8c1.4.5 2.3 1.7 2.3 3.2";
    case "people":
      // One person plus a check — narrower than "whole team".
      return "M7 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM2 13.5c0-2.2 2.2-3.9 5-3.9M10.5 12.2l1.4 1.4 2.6-2.8";
    case "link":
      return "M6.5 9.5a2.8 2.8 0 0 0 4 0l2-2a2.83 2.83 0 0 0-4-4l-1 1M9.5 6.5a2.8 2.8 0 0 0-4 0l-2 2a2.83 2.83 0 0 0 4 4l1-1";
    default:
      return "M4.5 7V5.2a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6.5h-9V7Z";
  }
}

export function shareAudienceShortLabel(audience: ShareAudience): string {
  switch (audience) {
    case "public":
      return "Anyone on the web";
    case "team":
      return "Your team";
    case "people":
      return "Specific people";
    case "link":
      return "Anyone with the link";
    default:
      return "Only you";
  }
}

/** Map stored loginAccess when the full audience model is not available. */
export function loginAccessToShareAudience(
  loginAccess: "private" | "team" | "public" | "none" | null,
): ShareAudience {
  if (loginAccess === "public") return "public";
  if (loginAccess === "team") return "team";
  if (loginAccess === "none") return "link";
  return "private";
}
