/**
 * papr-code-harness v1.2 — loop breaker for the bash tool.
 *
 * Agents sometimes re-run the same command with the same output for dozens of steps (on SWE-bench Pro, 6-8% of
 * runs and ~30% of all prompt tokens). A repeat = this (command, output) pair already appeared in the previous 3
 * bash calls of the same chat/job. From the 2nd repeat in a row the output gets a short note telling the agent it is
 * looping. Edit/test cycles change the command or the output, so they never count.
 *
 * Paprwork only adds the note; it never ends a chat. (The benchmark harness also force-submits after 20 repeats.)
 * Same rules as swebench-harness/harness/loop_breaker.py.
 */
import { createHash } from "crypto";

export const NOTE_AFTER = 2;
const WINDOW = 3;
const MAX_SESSIONS = 200;

interface State {
  hist: string[];
  run: number;
}
const sessions = new Map<string, State>();

const norm = (cmd: string) => cmd.trim().replace(/\s+/g, " ");

/** Returns a note to append to the output, or "" when this call is not part of a loop. */
export function checkLoop(sessionId: string, command: string, output: string): string {
  if (!sessionId || !command.trim()) return "";
  let s = sessions.get(sessionId);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
    s = { hist: [], run: 0 };
    sessions.set(sessionId, s);
  }
  const key = `${norm(command)}\u0000${createHash("sha1").update(output).digest("hex")}`;
  const repeat = s.hist.slice(-WINDOW).includes(key);
  s.hist.push(key);
  if (s.hist.length > 20) s.hist.shift();
  s.run = repeat ? s.run + 1 : 0;
  if (s.run < NOTE_AFTER) return "";
  return (
    `\n\n--- loop detected ---\nSame command, same output as a recent step (${s.run} repeats in a row). ` +
    "Repeating it will not change the result. Try a different approach: read another part of the code, " +
    "edit, run a different check, or report what you found.\n"
  );
}

/** Test helper. */
export function resetLoopState(): void {
  sessions.clear();
}
