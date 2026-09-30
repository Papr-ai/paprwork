/**
 * FreeformPrompt — the "Something else" escape hatch.
 *
 * Deliberately minimal: example pills above one chat box. Tapping a pill fills
 * the box so people edit instead of facing a blank field; Pen asks follow-ups
 * in chat for anything missing, so we don't coach inline here.
 */

import { useState } from "react";
import { PROMPT_PILLS } from "../../constants/onboardingPromptCoaching";

interface FreeformPromptProps {
  /** Hand the finished sentence to Pen in a new chat. */
  onSubmit: (prompt: string) => void;
  /** Return to the cards. Omitted when the host renders its own Back. */
  onBack?: () => void;
}

export function FreeformPrompt({ onSubmit, onBack }: FreeformPromptProps) {
  const [value, setValue] = useState("");
  const typed = value.trim();

  return (
    <section className="onboarding-freeform">
      {onBack && (
        <button type="button" className="onboarding-freeform__back" onClick={onBack}>
          ← Back
        </button>
      )}

      <h1 className="onboarding-view-title">What should Papr build for you?</h1>
      <p className="onboarding-freeform__lede">
        Describe the work. Pen builds the app, the jobs that run it on a schedule, and the
        connections to your tools — then asks about anything it needs.
      </p>

      <div className="onboarding-freeform__pills">
        {PROMPT_PILLS.map((pill) => (
          <button
            key={pill.label}
            type="button"
            className="onboarding-freeform__pill"
            onClick={() => setValue(pill.prompt)}
          >
            {pill.label}
          </button>
        ))}
      </div>

      <div className="onboarding-freeform__box">
        <textarea
          className="onboarding-freeform__input"
          rows={3}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && typed) {
              onSubmit(typed);
            }
          }}
          placeholder="e.g. Every morning, pull my open deals from HubSpot, flag the ones going cold and draft a follow-up for each"
        />
        <button
          type="button"
          className="onboarding-primary-btn"
          disabled={!typed}
          onClick={() => onSubmit(typed)}
        >
          Build it
        </button>
      </div>
    </section>
  );
}
