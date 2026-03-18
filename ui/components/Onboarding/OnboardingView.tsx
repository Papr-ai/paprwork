/**
 * OnboardingView - Full-screen onboarding experience
 * Shown in ContentArea instead of as a modal overlay
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTabStore } from "../../stores/tabStore";
import "./OnboardingView.css";

type StepState = "locked" | "active" | "completed";

interface OnboardingState {
  step1Completed: boolean;
  step2Completed: boolean;
  step3Completed: boolean;
}

export function OnboardingView() {
  const [state, setState] = useState<OnboardingState>({
    step1Completed: false,
    step2Completed: false,
    step3Completed: false,
  });
  const [isInitialized, setIsInitialized] = useState(false);

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
    if (state.step1Completed && state.step2Completed && state.step3Completed) {
      const timer = setTimeout(() => {
        localStorage.setItem("papr-onboarding-dismissed", "true");
        window.dispatchEvent(new CustomEvent('papr-onboarding-changed'));
      }, 1500);
      return () => clearTimeout(timer);
    }
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

  const handleStepClick = async (step: 1 | 2 | 3) => {
    const stepState = getStepState(step);
    if (stepState === "locked" || stepState === "completed") return;

    if (step === 1) {
      // Open Settings tab
      const { gateway } = await import('../../src/lib/gateway.js');
      await gateway.send('tab:open', { type: 'settings' });
      
      // Mark completed after short delay
      setTimeout(() => {
        setState((prev) => ({ ...prev, step1Completed: true }));
      }, 1000);
    } else if (step === 2) {
      // Create a new chat and send onboarding message
      const { gateway } = await import('../../src/lib/gateway.js');
      const result = await gateway.send('chat:create', {});
      
      if (result.success && result.data) {
        const chatId = result.data.id;
        
        // Open the chat tab
        await gateway.send('tab:open', { 
          type: 'chat', 
          entityId: chatId 
        });
        
        // Send the onboarding message
        window.dispatchEvent(
          new CustomEvent("papr-onboarding-send", { 
            detail: { 
              message: "Let's get started with onboarding! I'd like you to learn about me and set things up." 
            } 
          }),
        );
        
        // Mark completed after delay
        setTimeout(() => {
          setState((prev) => ({ ...prev, step2Completed: true }));
        }, 2000);
      }
    } else {
      // Send first task message to active chat
      window.dispatchEvent(
        new CustomEvent("papr-onboarding-send", { 
          detail: { 
            message: "Based on what you learned about me, help me with my first task or create an app that would be most useful for my work." 
          } 
        }),
      );
      
      // Mark completed
      setTimeout(() => {
        setState((prev) => ({ ...prev, step3Completed: true }));
      }, 2000);
    }
  };

  if (!isInitialized) return null;

  return (
    <div className="onboarding-view">
      <div className="onboarding-view-content">
        <div className="onboarding-view-header">
          <span className="onboarding-view-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 className="onboarding-view-title">Welcome to Paprwork!</h1>
          <p className="onboarding-view-subtitle">
            Let's get you set up in 3 quick steps
          </p>
        </div>

        <div className="onboarding-view-steps">
          {/* Step 1: Configure API Keys */}
          <div
            className={`onboarding-view-step ${getStepState(1)}`}
            onClick={() => handleStepClick(1)}
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
                <h3 className="step-title-view">Configure API Keys</h3>
                <p className="step-description-view">
                  Add your OpenAI, Anthropic, or Google API keys to get started
                </p>
              </div>
            </div>
          </div>

          {/* Step 2: Setup Your Agents */}
          <div
            className={`onboarding-view-step ${getStepState(2)}`}
            onClick={() => handleStepClick(2)}
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
            onClick={() => handleStepClick(3)}
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
            <strong>Start here:</strong> Click "Configure API Keys" to begin
          </p>
        </div>
      </div>
    </div>
  );
}
