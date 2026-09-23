/**
 * FreeformPrompt — the "Something else" escape hatch.
 *
 * Ported from the prototype's focusView. This is deliberately NOT a plain
 * textarea: a blank box after three concrete cards is intimidating, and the
 * prompts people write unaided tend to omit cadence and output shape — the two
 * things Pen most needs. So openers solve the first-three-words problem, and
 * the tips reveal as the sentence grows, teaching while they type rather than
 * correcting them afterwards.
 */

import { useState } from "react";
import {
  PROMPT_TIPS,
  PROMPT_EXAMPLES,
  PROMPT_STARTERS,
} from "../../constants/onboardingPromptCoaching";

interface FreeformPromptProps {
  /** Hand the finished sentence to Pen in a new chat. */
  onSubmit: (prompt: string) => void;
  /** Return to the cards. */
  onBack: () => void;
}

export function FreeformPrompt({ onSubmit, onBack }: FreeformPromptProps) {
  const [value, setValue] = useState("");
  const typed = value.trim();

  // Tips accumulate; the newest is highlighted, earlier ones read as met.
  const shownTips = PROMPT_TIPS.filter((t) => value.length >= t.at);

  return (
    <section className="onboarding-freeform">
      <button className="onboarding-freeform__back" onClick={onBack}>
        ← Back to the starters
      </button>

      <h1 className="onboarding-view-title">
        Describe what you want to happen
      </h1>
      <p className="onboarding-view-subtitle">
        One or two sentences. Pen will ask about anything it still needs.
      </p>

      <div className="onboarding-freeform__openers">
        {PROMPT_STARTERS.map((opener) => (
          <button
            key={opener}
            className="onboarding-freeform__opener"
            onClick={() => setValue(`${opener} `)}
          >
            {opener}
          </button>
        ))}
      </div>

      <textarea
        className="onboarding-freeform__input"
        rows={3}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Every morning, check which of my accounts are hiring and show me a ranked call list"
      />

      <div className="onboarding-freeform__coach">
        <p className="onboarding-freeform__coach-head">
          {typed ? "Making this a good prompt" : "A good prompt usually has"}
        </p>
        <ul className="onboarding-freeform__tips">
          {shownTips.map((t, i) => (
            <li
              key={t.at}
              className={
                i < shownTips.length - 1
                  ? "onboarding-freeform__tip is-met"
                  : "onboarding-freeform__tip is-now"
              }
            >
              {t.tip}
            </li>
          ))}
        </ul>
      </div>

      {!typed && (
        <div className="onboarding-freeform__coach">
          <p className="onboarding-freeform__coach-head">
            Or start from one of these
          </p>
          {PROMPT_EXAMPLES.map((example) => (
            <button
              key={example}
              className="onboarding-freeform__example"
              onClick={() => setValue(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}

      <button
        className="onboarding-primary-btn"
        disabled={!typed}
        onClick={() => onSubmit(typed)}
      >
        Build it
      </button>
    </section>
  );
}
