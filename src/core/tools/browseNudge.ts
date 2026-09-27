/**
 * Detects agents using snapshot → click loops to look something up, and nudges them
 * toward browser_goto. A "round" is a click followed by a snapshot. Typing or filling
 * a form means the agent is acting on the page, so the streak resets and no nudge fires.
 * State is keyed by browser session (page object) so concurrent sessions don't mix.
 */
export const LOOKUP_NUDGE_ROUNDS = 3;

export const LOOKUP_NUDGE_HINT =
  "You've done several snapshot→click rounds without filling any form. If you're looking for information, " +
  "browser_goto({ goal: \"...\" }) walks the site for you in one call and returns the answering passages.";

type Action = "snapshot" | "click" | "input" | "goto";

interface Streak {
  rounds: number;
  lastWasClick: boolean;
  sawInput: boolean;
  nudged: boolean;
}

const streaks = new WeakMap<object, Streak>();

function get(key: object): Streak {
  let s = streaks.get(key);
  if (!s) {
    s = { rounds: 0, lastWasClick: false, sawInput: false, nudged: false };
    streaks.set(key, s);
  }
  return s;
}

/** Record a browser action. For "snapshot", returns a hint when the agent should try browser_goto. */
export function recordBrowseAction(key: object, action: Action): string | undefined {
  const s = get(key);
  switch (action) {
    case "click":
      s.lastWasClick = true;
      return undefined;
    case "input":
      s.sawInput = true;
      s.rounds = 0;
      s.lastWasClick = false;
      return undefined;
    case "goto":
      s.rounds = 0;
      s.lastWasClick = false;
      s.sawInput = false;
      s.nudged = false;
      return undefined;
    case "snapshot":
      if (s.lastWasClick) s.rounds++;
      s.lastWasClick = false;
      if (s.rounds >= LOOKUP_NUDGE_ROUNDS && !s.sawInput && !s.nudged) {
        s.nudged = true;
        return LOOKUP_NUDGE_HINT;
      }
      return undefined;
  }
}
