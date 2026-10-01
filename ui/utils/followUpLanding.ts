/**
 * Follow-up "landing": a message the user queued while the agent was working
 * waits in the stack above the input bar. When the agent picks it up, the row
 * leaves the stack and the real user message mounts in the transcript — this
 * marks it so it arrives with one short slide instead of popping in.
 */

const LANDING_WINDOW_MS = 4_000;
const landing = new Map<string, { text: string; at: number }>();

export function markFollowUpLanding(
  chatId: string,
  text: string,
  now = Date.now(),
): void {
  landing.set(chatId, { text: text.trim(), at: now });
}

/** Non-consuming (safe under StrictMode double render); expires on its own. */
export function isLandingFollowUp(
  chatId: string,
  message: { role: string; content?: unknown },
  now = Date.now(),
): boolean {
  if (message.role !== "user" || typeof message.content !== "string") {
    return false;
  }
  const entry = landing.get(chatId);
  if (!entry) return false;
  if (now - entry.at > LANDING_WINDOW_MS) {
    landing.delete(chatId);
    return false;
  }
  return message.content.trim() === entry.text;
}

export function resetFollowUpLandingForTests(): void {
  landing.clear();
}
