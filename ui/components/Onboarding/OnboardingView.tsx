/**
 * OnboardingView - Full-screen onboarding experience
 * Shown in ContentArea instead of as a modal overlay
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useChat } from "../../hooks/useChat";
import "./OnboardingView.css";

type StepState = "locked" | "active" | "completed";

interface OnboardingState {
  step1Completed: boolean;
  step2Completed: boolean;
  step3Completed: boolean;
}

export function OnboardingView() {
  const { createTab, switchToTab } = useTabs();
  const { createChat } = useChat();
  const [state, setState] = useState<OnboardingState>({
    step1Completed: false,
    step2Completed: false,
    step3Completed: false,
  });
  const [isInitialized, setIsInitialized] = useState(false);

  const openSettings = useCallback(() => {
    const settingsId = createTab("settings", "settings", "Settings");
    switchToTab(settingsId);
  }, [createTab, switchToTab]);

  const sendInNewChat = useCallback(
    async (message: string): Promise<boolean> => {
      const chatId = await createChat();
      if (!chatId) return false;
      const tabId = createTab("chat", chatId, "New Chat");
      switchToTab(tabId);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", {
            detail: { message },
          }),
        );
      }, 300);
      return true;
    },
    [createChat, createTab, switchToTab],
  );

  // Load state from localStorage
  useEffect(() => {
    const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
    const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
    const step3 = localStorage.getItem("papr-onboarding-step3") === "true";

    setState({
      step1Completed: step1,
      step2Completed: step2,
      step3Completed: step3,
    });

    setIsInitialized(true);
  }, []);

  // Persist state changes
  useEffect(() => {
    if (!isInitialized) return;

    localStorage.setItem("papr-onboarding-step1", state.step1Completed.toString());
    localStorage.setItem("papr-onboarding-step2", state.step2Completed.toString());
    localStorage.setItem("papr-onboarding-step3", state.step3Completed.toString());

    window.dispatchEvent(new CustomEvent('papr-onboarding-changed'));
  }, [state, isInitialized]);

  // Auto-dismiss when all 3 steps complete
  useEffect(() => {
    if (
      !state.step1Completed ||
      !state.step2Completed ||
      !state.step3Completed
    ) {
      return;
    }
    const timer = setTimeout(() => {
      localStorage.setItem("papr-onboarding-dismissed", "true");
      window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
    }, 1500);
    return () => clearTimeout(timer);
  }, [state]);

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

  const handleStepClick = async (step: 1 | 2 | 3): Promise<void> => {
    // Step 1 always opens Settings (users often need to add another provider later)
    if (step === 1) {
      openSettings();
      if (!state.step1Completed) {
        window.setTimeout(() => {
          setState((prev) => ({ ...prev, step1Completed: true }));
        }, 1000);
      }
      return;
    }

    const stepState = getStepState(step);
    if (stepState === "locked" || stepState === "completed") return;

    if (step === 2) {
      const ok = await sendInNewChat(
        "Let's get started with onboarding! I'd like you to learn about me and set things up.",
      );
      if (!ok) return;
      window.setTimeout(() => {
        setState((prev) => ({ ...prev, step2Completed: true }));
      }, 2000);
      return;
    }

    const ok = await sendInNewChat(
      "Based on what you learned about me, help me with my first task or create an app that would be most useful for my work.",
    );
    if (!ok) return;
    window.setTimeout(() => {
      setState((prev) => ({ ...prev, step3Completed: true }));
    }, 2000);
  };

  if (!isInitialized) return null;

  return (
    <div className="onboarding-view">
      <div className="onboarding-view-content">
        <div className="onboarding-view-header">
          <span className="onboarding-view-icon">
            <img
              className="onboarding-view-logo"
              src="/papr-logo.svg"
              alt=""
              width={56}
              height={66}
            />
          </span>
          <h1 className="onboarding-view-title">Welcome to Paprwork!</h1>
          <p className="onboarding-view-subtitle">
            Let's get you set up in 3 quick steps
          </p>
        </div>

        <div className="onboarding-view-steps">
          {/* Step 1: Connect accounts / keys — always opens Settings when clicked */}
          <div
            className={`onboarding-view-step onboarding-view-step--settings ${getStepState(1)}`}
            onClick={() => void handleStepClick(1)}
          >
            <div className="step-number-view">1</div>
            <div className="step-content-view">
              <div className="step-icon-view">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="step-text-view">
                <h3 className="step-title-view">Connect ChatGPT, Claude, or your keys</h3>
                <p className="step-description-view">
                  Sign in with ChatGPT or Claude if you have a subscription, or add your own
                  API keys for OpenAI, Anthropic, or Google — all in Settings.
                </p>
              </div>
            </div>
          </div>

          {/* Step 2: Setup Your Agents */}
          <div
            className={`onboarding-view-step ${getStepState(2)}`}
            onClick={() => void handleStepClick(2)}
          >
            <div className="step-number-view">2</div>
            <div className="step-content-view">
              <div className="step-icon-view">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
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
              <div className="step-text-view">
                <h3 className="step-title-view">Setup Your Agents</h3>
                <p className="step-description-view">
                  Tell us about your work so we can configure your AI agents
                </p>
              </div>
            </div>
          </div>

          {/* Step 3: Complete First Task */}
          <div
            className={`onboarding-view-step ${getStepState(3)}`}
            onClick={() => void handleStepClick(3)}
          >
            <div className="step-number-view">3</div>
            <div className="step-content-view">
              <div className="step-icon-view">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="step-text-view">
                <h3 className="step-title-view">Complete First Task</h3>
                <p className="step-description-view">
                  Try your first task or let us build you a helpful app
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="onboarding-view-footer">
          <p className="onboarding-view-hint">
            <strong>Start here:</strong> Use the first step anytime to open Settings — connect
            ChatGPT or Claude, or add API keys.
          </p>
        </div>
      </div>
    </div>
  );
}
