/**
 * OnboardingCard - Compact collapsible card in sidebar footer
 * Matches V1's exact 3-step onboarding design
 * Reference: Paprwork v1 index.html lines 146-201, style.css lines 1004-1182
 */

import React, { useState, useEffect, useCallback } from "react";
import "./OnboardingCard.css";

type StepState = "locked" | "active" | "completed";

interface OnboardingState {
  step1Completed: boolean;
  step2Completed: boolean;
  step3Completed: boolean;
}

interface OnboardingCardProps {
  /** Open the Settings API Keys tab */
  onOpenSettings: () => void;
  /** Send a chat message to the agent */
  onSendMessage: (message: string) => void;
}

const STORAGE_KEY = "papr-onboarding-state";
const DISMISSED_KEY = "papr-onboarding-dismissed";

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as OnboardingState;
  } catch {
    // ignore
  }
  return {
    step1Completed: false,
    step2Completed: false,
    step3Completed: false,
  };
}

function saveState(state: OnboardingState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function isDismissed(): boolean {
  return localStorage.getItem(DISMISSED_KEY) === "true";
}

function dismiss(): void {
  localStorage.setItem(DISMISSED_KEY, "true");
}

export function OnboardingCard({
  onOpenSettings,
  onSendMessage,
}: OnboardingCardProps) {
  const [hidden, setHidden] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<OnboardingState>(loadState);
  const [slideOut, setSlideOut] = useState(false);

  // Show card only if not dismissed
  useEffect(() => {
    if (!isDismissed()) {
      setHidden(false);
    }
  }, []);

  // Persist state changes
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Auto-dismiss when all 3 steps complete
  useEffect(() => {
    if (state.step1Completed && state.step2Completed && state.step3Completed) {
      const timer = setTimeout(() => {
        setSlideOut(true);
        setTimeout(() => {
          dismiss();
          setHidden(true);
        }, 300);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [state]);

  const completedCount =
    (state.step1Completed ? 1 : 0) +
    (state.step2Completed ? 1 : 0) +
    (state.step3Completed ? 1 : 0);

  const progressPercent = Math.round((completedCount / 3) * 100);

  const getStepState = useCallback(
    (step: 1 | 2 | 3): StepState => {
      if (step === 1) return state.step1Completed ? "completed" : "active";
      if (step === 2) {
        if (state.step2Completed) return "completed";
        return state.step1Completed ? "active" : "locked";
      }
      // step 3
      if (state.step3Completed) return "completed";
      return state.step2Completed ? "active" : "locked";
    },
    [state],
  );

  const handleStepClick = (step: 1 | 2 | 3) => {
    const stepState = getStepState(step);
    if (stepState === "locked" || stepState === "completed") return;

    if (step === 1) {
      // Open Settings → API Keys
      onOpenSettings();
      // Mark completed after a short delay (user will configure keys)
      // In V1 this polls for keys; we simplify by marking done after opening
      setTimeout(() => {
        setState((prev) => ({ ...prev, step1Completed: true }));
      }, 1000);
    } else if (step === 2) {
      // Trigger the onboarding flow — the ONBOARD.md script is injected into
      // the system prompt by WorkspaceService. The agent will follow its
      // interview-then-configure workflow automatically.
      onSendMessage(
        "Let's get started with onboarding! I'd like you to learn about me and set things up.",
      );
      // Mark completed after sending (agent will handle the rest via ONBOARD.md)
      setTimeout(() => {
        setState((prev) => ({ ...prev, step2Completed: true }));
      }, 2000);
    } else {
      // Send a first task prompt — let agent decide based on what it learned
      onSendMessage(
        "Based on what you learned about me, help me with my first task " +
          "or create an app that would be most useful for my work.",
      );
      // Mark completed after sending
      setTimeout(() => {
        setState((prev) => ({ ...prev, step3Completed: true }));
      }, 2000);
    }
  };

  if (hidden) return null;

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

      <div className="onboarding-progress-bar">
        <div
          className="onboarding-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {expanded && (
        <div className="onboarding-expanded">
          <div className="onboarding-steps-compact">
            {/* Step 1: Configure API Keys */}
            <div
              className={`onboarding-step-compact ${getStepState(1)}`}
              onClick={() => handleStepClick(1)}
            >
              <div className="step-number-compact">1</div>
              <div className="step-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="step-label-compact">Configure API Keys</span>
            </div>

            {/* Step 2: Setup Your Agents */}
            <div
              className={`onboarding-step-compact ${getStepState(2)}`}
              onClick={() => handleStepClick(2)}
            >
              <div className="step-number-compact">2</div>
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

            {/* Step 3: Complete First Task */}
            <div
              className={`onboarding-step-compact ${getStepState(3)}`}
              onClick={() => handleStepClick(3)}
            >
              <div className="step-number-compact">3</div>
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
