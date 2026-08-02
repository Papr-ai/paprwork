/**
 * OnboardingView - PLG onboarding experience
 * 
 * Flow: Welcome → Connect Papr → Connect AI Model → Choose Intent → First Value
 * 
 * Key principles:
 * - Model connection is a prerequisite (ChatGPT/Claude accounts)
 * - Intent cards replace generic checklist
 * - Steps complete only when real work happens
 * - Users can skip/dismiss at any point
 */

import React, { useState, useEffect, useCallback } from "react";
import { INTENT_PROMPTS, INTENT_LABELS } from "../../constants/onboardingMessages";
import { useTabs } from "../../hooks/useTabs";
import { useChat } from "../../hooks/useChat";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { trackEvent } from "../../lib/telemetry";
import {
  getOnboardingState,
  transitionTo,
  dismissOnboarding,
  markModelConnected,
  markPaprConnected,
  markFirstChatSent,
  type OnboardingPhase,
  type OnboardingIntent,
  type OnboardingState,
} from "../../utils/onboardingState";
import { ProviderBrandIcon } from "../Settings/ProviderBrandIcon";
import "./OnboardingView.css";

const INTENT_ICONS: Record<string, React.ReactNode> = {
  explore: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  finish_work: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  build_app: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17.5 14v7M14 17.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  personalize: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 21c0-4.42 3.58-8 8.5-8s8.5 3.58 8.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="18" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M18 4v2M17 5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

export function OnboardingView() {
  const { createTab, switchToTab } = useTabs();
  const { createChat } = useChat();
  const { keys, loading: keysLoading } = useCustomKeys();
  const [state, setState] = useState<OnboardingState>(getOnboardingState);
  const [checkingKeys, setCheckingKeys] = useState(true);
  const [paprLoggedIn, setPaprLoggedIn] = useState(false);
  const [checkingPapr, setCheckingPapr] = useState(true);

  // Check if user has any AI model key configured
  const hasModelKey = keys.some(
    (k) =>
      k.name === "OPENAI_API_KEY" ||
      k.name === "ANTHROPIC_API_KEY" ||
      k.name === "GOOGLE_API_KEY",
  );

  // Check Papr login status on mount and after auth events
  useEffect(() => {
    let cancelled = false;

    const refreshPaprStatus = async () => {
      try {
        const result = await window.electronAPI.papr.checkLoginStatus();
        if (cancelled) return;
        const loggedIn = result.success && result.isLoggedIn === true;
        setPaprLoggedIn(loggedIn);
        if (loggedIn) {
          const next = markPaprConnected();
          setState(next);
        }
      } catch {
        if (!cancelled) setPaprLoggedIn(false);
      } finally {
        if (!cancelled) setCheckingPapr(false);
      }
    };

    void refreshPaprStatus();

    const onAuthSuccess = () => {
      void refreshPaprStatus();
    };
    window.addEventListener("papr-auth-success", onAuthSuccess);
    return () => {
      cancelled = true;
      window.removeEventListener("papr-auth-success", onAuthSuccess);
    };
  }, []);

  // When keys load, detect model connection and advance phase
  useEffect(() => {
    if (keysLoading || checkingPapr) return;
    setCheckingKeys(false);

    if (hasModelKey && state.phase === "connect_model") {
      const next = markModelConnected();
      setState(next);
    }
    // Skip connect_papr if already logged in
    if (paprLoggedIn && state.phase === "welcome") {
      if (hasModelKey) {
        const next = transitionTo("choose_intent", {
          paprConnected: true,
          modelConnected: true,
        });
        setState(next);
      } else {
        const next = transitionTo("connect_model", { paprConnected: true });
        setState(next);
      }
    }
  }, [keysLoading, checkingPapr, hasModelKey, paprLoggedIn, state.phase]);

  // Listen for key changes (user adds key in Settings while onboarding is open)
  useEffect(() => {
    const handler = () => {
      setState(getOnboardingState());
    };
    window.addEventListener("papr-onboarding-changed", handler);
    return () => window.removeEventListener("papr-onboarding-changed", handler);
  }, []);

  useEffect(() => {
    trackEvent("paprwork_onboarding_started", { phase: state.phase } as Record<string, unknown>);
  }, []);

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

  const handleGetStarted = () => {
    if (paprLoggedIn && hasModelKey) {
      const next = transitionTo("choose_intent", {
        paprConnected: true,
        modelConnected: true,
      });
      setState(next);
    } else if (paprLoggedIn) {
      const next = transitionTo("connect_model", { paprConnected: true });
      setState(next);
    } else {
      const next = transitionTo("connect_papr");
      setState(next);
    }
    trackEvent("paprwork_onboarding_step_completed", { step_name: "welcome" } as Record<string, unknown>);
  };

  const handleOpenProfile = () => {
    const tabId = createTab("settings", "settings", "Settings");
    switchToTab(tabId);
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", { detail: { tab: "profile" } }),
    );
    trackEvent("paprwork_onboarding_open_profile", {} as Record<string, unknown>);
  };

  const handlePaprConnected = () => {
    const next = markPaprConnected();
    setState(next);
    trackEvent("paprwork_onboarding_step_completed", { step_name: "connect_papr" } as Record<string, unknown>);
  };

  const handleOpenModels = () => {
    const tabId = createTab("settings", "settings", "Settings");
    switchToTab(tabId);
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", { detail: { tab: "models" } }),
    );
    trackEvent("paprwork_onboarding_open_models", {} as Record<string, unknown>);
  };

  const handleModelConnected = () => {
    const next = markModelConnected();
    setState(next);
    trackEvent("paprwork_onboarding_step_completed", { step_name: "connect_model" } as Record<string, unknown>);
  };

  const handleIntentClick = async (intentKey: string) => {
    const intent = intentKey as OnboardingIntent;
    const prompt = INTENT_PROMPTS[intentKey as keyof typeof INTENT_PROMPTS];
    if (!prompt) return;

    trackEvent("paprwork_onboarding_intent_selected", { intent: intentKey } as Record<string, unknown>);

    // "Explore" intent opens Community Apps tab directly
    if (prompt === "__OPEN_COMMUNITY_APPS__") {
      const tabId = createTab("apps" as any, "apps", "Apps");
      switchToTab(tabId);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-apps-view-tab", { detail: { tab: "community" } }),
        );
      }, 100);

      const next = transitionTo("first_value", { intent, firstChatSent: false });
      setState(next);
      trackEvent("paprwork_onboarding_step_completed", {
        step_name: "choose_intent",
        intent: intentKey,
      } as Record<string, unknown>);

      setTimeout(() => {
        dismissOnboarding();
        window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
      }, 500);
      return;
    }

    const ok = await sendInNewChat(prompt);
    if (!ok) return;

    markFirstChatSent();
    const next = transitionTo("first_value", { intent, firstChatSent: true });
    setState(next);

    trackEvent("paprwork_onboarding_step_completed", {
      step_name: "choose_intent",
      intent: intentKey,
    } as Record<string, unknown>);

    // Auto-dismiss after sending — user is now in the chat doing real work
    setTimeout(() => {
      dismissOnboarding();
      window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
    }, 500);
  };

  const handleSkip = () => {
    trackEvent("paprwork_onboarding_skipped", { phase: state.phase } as Record<string, unknown>);
    dismissOnboarding();
    window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
  };

  if (checkingKeys || checkingPapr) {
    return (
      <div className="onboarding-view">
        <div className="onboarding-view-content onboarding-view-content--loading">
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-view">
      <div className="onboarding-view-content">
        {/* ---- WELCOME PHASE ---- */}
        {state.phase === "welcome" && (
          <>
            <div className="onboarding-view-header">
              <h1 className="onboarding-view-title">Welcome to Paprwork</h1>
              <p className="onboarding-view-subtitle">
                Your AI workspace that builds apps, automates workflows, and gets smarter the more you use it.
              </p>
            </div>
            <div className="onboarding-view-actions">
              <button className="onboarding-primary-btn" onClick={handleGetStarted}>
                Get Started
              </button>
              <button className="onboarding-skip-btn" onClick={handleSkip}>
                Skip for now
              </button>
            </div>
          </>
        )}

        {/* ---- CONNECT PAPR PHASE ---- */}
        {state.phase === "connect_papr" && (
          <>
            <div className="onboarding-view-header">
              <span className="onboarding-view-icon onboarding-view-icon--key">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2a5 5 0 00-5 5v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V11a2 2 0 00-2-2h-1V7a5 5 0 00-5-5z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="16" r="1.5" fill="currentColor" />
                </svg>
              </span>
              <h1 className="onboarding-view-title">Connect to Papr</h1>
              <p className="onboarding-view-subtitle">
                Sign in to Papr for memory, cloud sync, and team workspaces. This takes about 30 seconds.
              </p>
            </div>

            <div className="onboarding-view-actions">
              {paprLoggedIn ? (
                <button className="onboarding-primary-btn" onClick={handlePaprConnected}>
                  ✓ Connected to Papr — Continue
                </button>
              ) : (
                <>
                  <button className="onboarding-primary-btn" onClick={handleOpenProfile}>
                    Open Profile to Sign In
                  </button>
                  <p className="onboarding-model-hint">
                    Settings → Profile → Sign in with Papr
                  </p>
                </>
              )}
              <button className="onboarding-skip-btn" onClick={handleSkip}>
                I'll do this later
              </button>
            </div>
          </>
        )}

        {/* ---- CONNECT MODEL PHASE ---- */}
        {state.phase === "connect_model" && (
          <>
            <div className="onboarding-view-header">
              <span className="onboarding-view-icon onboarding-view-icon--key">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <h1 className="onboarding-view-title">Connect Your AI</h1>
              <p className="onboarding-view-subtitle">
                Connect your ChatGPT or Claude account to power Papr with the best AI models. This takes about 30 seconds.
              </p>
            </div>

            <div className="onboarding-model-cards">
              <button className="onboarding-model-card" onClick={handleOpenModels}>
                <span className="onboarding-model-card__brand">
                  <ProviderBrandIcon providerId="openai" size={20} onLightSurface />
                </span>
                <div className="onboarding-model-card__name">OpenAI (ChatGPT)</div>
                <div className="onboarding-model-card__hint">GPT-5.4, GPT-5.3 Codex</div>
                <div className="onboarding-model-card__action">Connect →</div>
              </button>
              <button className="onboarding-model-card" onClick={handleOpenModels}>
                <span className="onboarding-model-card__brand">
                  <ProviderBrandIcon providerId="anthropic" size={20} />
                </span>
                <div className="onboarding-model-card__name">Anthropic (Claude)</div>
                <div className="onboarding-model-card__hint">Claude Opus 4, Sonnet 4</div>
                <div className="onboarding-model-card__action">Connect →</div>
              </button>
            </div>

            <div className="onboarding-view-actions">
              {hasModelKey ? (
                <button className="onboarding-primary-btn" onClick={handleModelConnected}>
                  ✓ Model connected — Continue
                </button>
              ) : (
                <p className="onboarding-model-hint">
                  Open Settings → AI Models to sign in with your existing ChatGPT or Claude subscription.
                </p>
              )}
              <button className="onboarding-skip-btn" onClick={handleSkip}>
                I'll do this later
              </button>
            </div>
          </>
        )}

        {/* ---- CHOOSE INTENT PHASE (also shown when reopening after completion) ---- */}
        {(state.phase === "choose_intent" ||
          state.phase === "first_value" ||
          state.phase === "activated" ||
          state.phase === "completed") && (
          <>
            <div className="onboarding-view-header">
              <h1 className="onboarding-view-title">What would you like to do?</h1>
              <p className="onboarding-view-subtitle">
                Pick one to get started with real work right away.
              </p>
            </div>

            <div className="onboarding-intent-cards">
              {(Object.keys(INTENT_LABELS) as Array<keyof typeof INTENT_LABELS>).map((key) => {
                const label = INTENT_LABELS[key];
                return (
                  <button
                    key={key}
                    className="onboarding-intent-card"
                    onClick={() => void handleIntentClick(key)}
                  >
                    <div className="onboarding-intent-card__icon">
                      {INTENT_ICONS[key]}
                    </div>
                    <div className="onboarding-intent-card__text">
                      <div className="onboarding-intent-card__title">{label.title}</div>
                      <div className="onboarding-intent-card__desc">{label.description}</div>
                      {"examples" in label && (
                        <div className="onboarding-intent-card__examples">
                          {(label as any).examples.map((ex: string) => (
                            <span key={ex} className="onboarding-intent-card__example-pill">{ex}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="onboarding-view-actions">
              <button className="onboarding-skip-btn" onClick={handleSkip}>
                Skip — I'll just start chatting
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
