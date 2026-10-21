"use strict";

/**
 * Hidden mini-app previews each keep a job-events SSE connection open to the local gateway.
 * Chromium allows ~6 connections per origin over HTTP/1.1, so a handful of forgotten previews
 * starves the app tab the user is actually looking at (blank screen, "Renderer unresponsive").
 * Cap the number of open previews and close the oldest when a new one launches.
 */
const MAX_WEBVIEW_SESSIONS = 3;

/**
 * @param {Array<{ id: string, createdAt: string }>} sessions open previews
 * @param {number} [max] sessions allowed AFTER the new one opens
 * @returns {string[]} ids to close, oldest first
 */
function pickSessionsToClose(sessions, max = MAX_WEBVIEW_SESSIONS) {
  const keep = Math.max(0, max - 1);
  const excess = sessions.length - keep;
  if (excess <= 0) return [];
  return [...sessions]
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, excess)
    .map((s) => s.id);
}

module.exports = { MAX_WEBVIEW_SESSIONS, pickSessionsToClose };
