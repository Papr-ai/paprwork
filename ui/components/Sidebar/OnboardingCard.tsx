/**
 * OnboardingCard - Compact sidebar card reflecting new state machine
 * 
 * Shows phase-aware progress and lets users resume or open the full guide.
 * State is driven by onboardingState.ts — no more independent localStorage flags.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  getOnboardingState,
  dismissOnboarding,
  shouldShowOnboarding,
  type OnboardingState,
  type OnboardingPhase,
} from "../../utils/onboardingState";
import { INTENT_PROMPTS } from "../../constants/onboardingMessages";
import "./OnboardingCard.css";

interface OnboardingCardProps {
  onOpenGettingStarted: () => void;
  onSendMessage: (message: string) => void;
}

const PHASE_LABELS: Record<OnboardingPhase, string> = {
  welcome: "Get started",
  connect_papr: "Connect to Papr",
  connect_model: "Connect AI model",
  choose_intent: "Choose what to do",
  first_value: "Working on first task",
  activated: "Almost done",
  completed: "Complete",
};

const PHASE_ORDER: OnboardingPhase[] = [
  "welcome",
  "connect_papr",
  "connect_model",
  "choose_intent",
  "first_value",
  "activated",
  "completed",
];

function getProgress(phase: OnboardingPhase): number {
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 0;
  return Math.round((idx / (PHASE_ORDER.length - 1)) * 100);
}

export function OnboardingCard({
  onOpenGettingStarted,
  onSendMessage,
}: OnboardingCardProps) {
  const [state, setState] = useState<OnboardingState>(getOnboardingState);
  const [slideOut, setSlideOut] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Listen for state changes
  useEffect(() => {
    const handler = () => setState(getOnboardingState());
    window.addEventListener("papr-onboarding-changed", handler);
    return () => window.removeEventListener("papr-onboarding-changed", handler);
  }, []);

  const handleDismiss = useCallback(() => {
    setSlideOut(true);
    setTimeout(() => {
      dismissOnboarding();
    }, 300);
  }, []);

  // After completion, auto-dismiss
  useEffect(() => {
    if (state.phase === "completed" || state.phase === "activated") {
      const timer = setTimeout(() => handleDismiss(), 2000);
      return () => clearTimeout(timer);
    }
  }, [state.phase, handleDismiss]);

  // If onboarding is done, show the persistent link
  if (!shouldShowOnboarding()) {
    return (
      <button
        type="button"
        className="onboarding-persistent-link"
        onClick={onOpenGettingStarted}
      >
        <span className="onboarding-icon" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </span>
        Getting started
      </button>
    );
  }

  const progress = getProgress(state.phase);

  return (
    <div className={`onboarding-card-compact${slideOut ? " slide-out" : ""}`}>
      <div
        className="onboarding-compact-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="onboarding-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="onboarding-compact-info">
          <span className="onboarding-compact-title">Getting started</span>
          <span className="onboarding-compact-progress">{progress}%</span>
        </div>
        <span className={`onboarding-chevron${expanded ? " expanded" : ""}`}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>

      <button
        type="button"
        className="onboarding-open-guide"
        onClick={(e) => { e.stopPropagation(); onOpenGettingStarted(); }}
      >
        Open full guide
      </button>

      <div className="onboarding-progress-bar">
        <div className="onboarding-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {expanded && (
        <div className="onboarding-expanded">
          <div className="onboarding-steps-compact">
            {PHASE_ORDER.slice(0, -1).map((phase, i) => {
              const currentIdx = PHASE_ORDER.indexOf(state.phase);
              const phaseIdx = PHASE_ORDER.indexOf(phase);
              const stepState = phaseIdx < currentIdx ? "completed" : phaseIdx === currentIdx ? "active" : "locked";

              return (
                <div
                  key={phase}
                  className={`onboarding-step-compact ${stepState}`}
                  onClick={() => {
                    if (stepState === "active") onOpenGettingStarted();
                  }}
                >
                  <div className="step-number-compact">{i + 1}</div>
                  <span className="step-label-compact">{PHASE_LABELS[phase]}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
