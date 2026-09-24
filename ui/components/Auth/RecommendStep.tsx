/**
 * RecommendStep — final stage of the pre-app auth flow.
 *
 * The prototype puts the "what should Papr do for you every day?" screen BEFORE
 * the workspace exists (stage C of 4), so it reads as the last step of setup
 * rather than a tab you can click away from. This hosts it there.
 *
 * RELEASE ORDER IS THE WHOLE TRICK. RecommendedApps installs by opening a chat
 * tab + app tab and merging them into split view — but while this component is
 * mounted, App.tsx is rendering the gate INSTEAD of the workspace, so there is
 * no tab UI for them to land in. So we call onComplete() first (unmounting the
 * gate, mounting the workspace) and let the install continue underneath: the
 * install flow drives tabStore via getState() and dispatches its welcome event
 * on a timer, neither of which needs this component to stay alive.
 *
 * Same reasoning for freeform — `papr-onboarding-send` is only heard by the
 * workspace, so the gate must be gone before it fires.
 */

import { useCallback, useEffect, useState } from "react";
import { RecommendedApps } from "../Onboarding/RecommendedApps";
import {
  getOnboardingState,
  saveOnboardingState,
} from "../../utils/onboardingState";
import { trackEvent } from "../../lib/telemetry";
import { recordOnboardingComplete } from "../../utils/onboardingRemote";
import { AuthProgressDots } from "./AuthProgressDots";
import { openChatWithPrompt } from "../../utils/openChatWithPrompt";
import "../Onboarding/OnboardingView.css";
import "./onboardingTheme.css";
import "./RecommendStep.css";

interface RecommendStepProps {
  /** Release the gate and render the workspace. */
  onComplete: () => void;
  /**
   * Settings → Dev. Renders the real screen but never writes onboarding state
   * (local or Parse) — previewing must not mark your account as onboarded.
   * Installs still run for real.
   */
  previewMode?: boolean;
}

export function RecommendStep({ onComplete, previewMode = false }: RecommendStepProps) {
  /**
   * The ribbon confirms the previous stage stuck. We read the status here
   * rather than have ConnectAIStep report it, so the shared onDone signature
   * stays untouched and the line is correct even for someone who arrived
   * already connected.
   */
  const [providerLine, setProviderLine] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [claude, openai] = await Promise.all([
        window.electronAPI.oauth.claude.getStatus().catch(() => null),
        window.electronAPI.oauth.openai.getStatus().catch(() => null),
      ]);
      if (cancelled) return;
      if (claude?.connected && !claude.isExpired) {
        setProviderLine("Connected to Claude.");
      } else if (openai?.connected && !openai.isExpired) {
        setProviderLine("Connected to ChatGPT.");
      } else {
        setProviderLine("Using your own API key.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The user has now made their real first choice inside setup, so the
   * in-workspace onboarding tab must not ask again. Advancing the phase past
   * `recommend` is what stops OnboardingView re-showing this screen.
   */
  const advancePhase = useCallback(
    (phase: "first_value" | "choose_intent", patch: Partial<ReturnType<typeof getOnboardingState>> = {}) => {
      if (previewMode) return;
      saveOnboardingState({
        ...getOnboardingState(),
        phase,
        modelConnected: true,
        ...patch,
      });
      window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
      // Durable, per-user record — this is the last gated stage, so reaching
      // any exit means setup is finished. Skipping still counts: the user made
      // a choice and must not be re-gated on their next machine.
      void recordOnboardingComplete();
    },
    [previewMode],
  );

  const handleInstalling = useCallback(
    (appName: string) => {
      trackEvent("paprwork_onboarding_intent_selected", {
        intent: "explore",
        source: "auth_recommend",
        app_name: appName,
      } as Record<string, unknown>);
      advancePhase("first_value", { intent: "explore", firstChatSent: true });
      onComplete();
    },
    [advancePhase, onComplete],
  );

  const handleFreeform = useCallback(
    (prompt: string) => {
      trackEvent("paprwork_onboarding_intent_selected", {
        intent: "build_app",
        source: "auth_recommend_freeform",
      } as Record<string, unknown>);
      advancePhase("first_value", { intent: "build_app", firstChatSent: true });
      onComplete();
      // Open a real chat tab first — the send event is only heard by a mounted
      // ChatContainer, and a just-released workspace may not have one.
      openChatWithPrompt(prompt);
    },
    [advancePhase, onComplete],
  );

  const handleSkip = useCallback(() => {
    trackEvent("paprwork_onboarding_skipped", {
      phase: "auth_recommend",
    } as Record<string, unknown>);
    // Not a dismissal — they still land on the in-workspace intent step.
    advancePhase("choose_intent");
    onComplete();
  }, [advancePhase, onComplete]);

  return (
    // Same shell as AuthWall / ConnectAIStep (light onboarding theme), laid out
    // like the prototype's stage C: dots → ribbon → headline → lede → tiles.
    <div className="onboarding-flow onboarding-screen recommend-step">
      <div className="onboarding-screen-inner recommend-step__inner">
        {/* Same head row as the Claude stepper: dots left, Skip right. */}
        <div className="onboarding-head-row">
          <AuthProgressDots activeIndex={3} />
          <button type="button" className="onboarding-skip-btn" onClick={handleSkip}>
            Skip
          </button>
        </div>
        {providerLine && <p className="recommend-step__ribbon">{providerLine}</p>}
        <h1 className="onboarding-h1">What should Papr do for you every day?</h1>
        <p className="onboarding-lede">
          Pick one and Papr installs it, then personalizes it with you in chat.
          You will see the first real result in a few minutes.
        </p>
        {/* Ribbon is rendered above the headline here, so don't pass it down. */}
        <RecommendedApps
          onInstalling={handleInstalling}
          onFreeform={handleFreeform}
          onSkip={handleSkip}
          hideSkip
        />
      </div>
    </div>
  );
}
