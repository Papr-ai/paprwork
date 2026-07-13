/**
 * OnboardingCard - Compact collapsible card in sidebar footer
 * Post-signin: Papr AI proxy provides model access, so only 2 steps needed.
 * 
 * State is persisted to settings.json via Gateway WebSocket
 */

import React, { useState, useEffect, useCallback } from "react";
import { ONBOARDING_SETUP_MESSAGE } from "../../constants/onboardingMessages";
import "./OnboardingCard.css";

type StepState = "locked" | "active" | "completed";

interface OnboardingState {
  step1Completed: boolean;
  step2Completed: boolean;
}

interface OnboardingCardProps {
  /** Open the Getting Started tab (full onboarding guide) */
  onOpenGettingStarted: () => void;
  /** Send a chat message to the agent */
  onSendMessage: (message: string) => void;
}

export function OnboardingCard({
  onOpenGettingStarted,
  onSendMessage,
}: OnboardingCardProps) {
  const [hidden, setHidden] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<OnboardingState>({
    step1Completed: false,
    step2Completed: false,
  });
  const [slideOut, setSlideOut] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load state from settings (populated by App.tsx on mount)
  useEffect(() => {
    const dismissed = localStorage.getItem("papr-onboarding-dismissed") === "true";
    const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
    const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
    
    setHidden(dismissed);
    setState({
      step1Completed: step1,
      step2Completed: step2,
    });
    
    setIsInitialized(true);
  }, []);

  // Persist state changes to localStorage
  useEffect(() => {
    if (!isInitialized) return;
    
    localStorage.setItem("papr-onboarding-step1", state.step1Completed.toString());
    localStorage.setItem("papr-onboarding-step2", state.step2Completed.toString());
    
    window.dispatchEvent(new CustomEvent('papr-onboarding-changed'));
  }, [state, isInitialized]);

  // Auto-dismiss when both steps complete
  useEffect(() => {
    if (!state.step1Completed || !state.step2Completed) {
      return;
    }
    const timer = setTimeout(() => {
      setSlideOut(true);
      setTimeout(() => {
        localStorage.setItem("papr-onboarding-dismissed", "true");
        window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
        setHidden(true);
      }, 300);
    }, 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const completedCount =
    (state.step1Completed ? 1 : 0) +
    (state.step2Completed ? 1 : 0);

  const progressPercent = Math.round((completedCount / 2) * 100);

  const getStepState = useCallback(
    (step: 1 | 2): StepState => {
      if (step === 1) return state.step1Completed ? "completed" : "active";
      if (state.step2Completed) return "completed";
      return state.step1Completed ? "active" : "locked";
    },
    [state],
  );

  const handleStepClick = (step: 1 | 2) => {
    const stepState = getStepState(step);
    if (stepState === "locked" || stepState === "completed") return;

    if (step === 1) {
      onSendMessage(ONBOARDING_SETUP_MESSAGE);
      setTimeout(() => {
        setState((prev) => ({ ...prev, step1Completed: true }));
      }, 2000);
    } else {
      onSendMessage(
        "Based on what you learned about me, help me with my first task " +
          "or create an app that would be most useful for my work.",
      );
      setTimeout(() => {
        setState((prev) => ({ ...prev, step2Completed: true }));
      }, 2000);
    }
  };

  // After onboarding is dismissed or finished, keep a slim entry to reopen the full guide
  if (hidden) {
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
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        Getting started
      </button>
    );
  }

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
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="onboarding-compact-info">
          <span className="onboarding-compact-title">Getting started</span>
          <span className="onboarding-compact-progress">
            {progressPercent}%
          </span>
        </div>
        <span className={`onboarding-chevron${expanded ? " expanded" : ""}`}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>

      <button
        type="button"
        className="onboarding-open-guide"
        onClick={(e) => {
          e.stopPropagation();
          onOpenGettingStarted();
        }}
      >
        Open full guide
      </button>

      <div className="onboarding-progress-bar">
        <div
          className="onboarding-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {expanded && (
        <div className="onboarding-expanded">
          <div className="onboarding-steps-compact">
            {/* Step 1: Setup Your Agents */}
            <div
              className={`onboarding-step-compact ${getStepState(1)}`}
              onClick={() => handleStepClick(1)}
            >
              <div className="step-number-compact">1</div>
              <div className="step-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L2 7l10 5 10-5-10-5z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M2 17l10 5 10-5M2 12l10 5 10-5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="step-label-compact">Setup Your Agents</span>
            </div>

            {/* Step 2: Complete First Task */}
            <div
              className={`onboarding-step-compact ${getStepState(2)}`}
              onClick={() => handleStepClick(2)}
            >
              <div className="step-number-compact">2</div>
              <div className="step-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="step-label-compact">Complete First Task</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
