/**
 * AuthFlow — host for the continuous pre-app onboarding flow.
 *
 *   signin (AuthWall) → org (OrgNamespaceSetup) → connect (ConnectAIStep)
 *     → recommend (RecommendStep) → app
 *
 * `recommend` is the last gated stage: the user picks their first automation
 * while still in setup, rather than being dropped into an empty workspace with
 * a dismissible tab. It releases the gate itself (see RecommendStep) because
 * installing needs the workspace tabs to exist.
 *
 * Owns the stage machine, the org-setup request listeners, and the single
 * "you are now authenticated" side effect. Children are presentational steps
 * that report upward — they do not decide what comes next.
 */

import { useCallback, useEffect, useState } from "react";
import { setTelemetryPaprUserId, trackEvent } from "../../lib/telemetry";
import { useProfileStore } from "../../stores/profileStore";
import { AuthWall } from "./AuthWall";
import {
  OrgNamespaceSetup,
  type OrgNamespaceSetupRequest,
} from "./OrgNamespaceSetup";
import { ConnectAIStep } from "./ConnectAIStep";
import { RecommendStep } from "./RecommendStep";
import { transitionTo } from "../../utils/onboardingState";
import {
  fetchRemoteOnboarding,
  recordOnboardingStep,
  type OnboardingStepId,
} from "../../utils/onboardingRemote";

export type AuthFlowStage = "signin" | "org" | "connect" | "recommend";

interface AuthFlowProps {
  /** Called once the user has cleared every pre-app stage. */
  onComplete: () => void;
  /**
   * Dev preview only (Settings → Dev). Starts the flow on a given stage and
   * stops AuthWall auto-advancing past sign-in when you're already logged in.
   * Never set in the packaged app — the whole tab is compiled out.
   */
  devPreview?: {
    initialStage: AuthFlowStage;
    orgRequest: OrgNamespaceSetupRequest;
  };
}

async function identifyTelemetryAfterLogin(): Promise<void> {
  try {
    const profileResult = await window.electronAPI.papr.getProfile();
    const userId = profileResult?.profile?.userId;
    if (userId) {
      setTelemetryPaprUserId(userId);
    }
  } catch {
    // Non-fatal — login still succeeded
  }
}

export function AuthFlow({ onComplete, devPreview }: AuthFlowProps) {
  const [stage, setStage] = useState<AuthFlowStage>(
    devPreview?.initialStage ?? "signin",
  );
  const [setupRequest, setSetupRequest] =
    useState<OrgNamespaceSetupRequest | null>(devPreview?.orgRequest ?? null);
  /**
   * Did this USER already finish onboarding, on any machine? Read from Parse
   * after sign-in, since onboarding state is per-user and the gate previously
   * only remembered per-browser-profile.
   */
  const [alreadyOnboarded, setAlreadyOnboarded] = useState(false);
  /** Set when the user steps back from recommend → connect. */
  const [returnedToConnect, setReturnedToConnect] = useState(false);

  // Server-side breadcrumb for resume + funnel drop-off. Not load-bearing for
  // navigation — the stage machine is still driven locally.
  useEffect(() => {
    if (devPreview) return; // Don't let previewing a stage rewrite real progress.
    recordOnboardingStep(stage as OnboardingStepId);
    // `signin` and `org` own components emit no telemetry, so without this the
    // funnel starts at stage 3 and drop-off before sign-in is invisible.
    // `connect` and `recommend` self-report (ConnectAIStep / RecommendedApps) —
    // emitting here too would double-count them.
    if (stage === "signin" || stage === "org") {
      trackEvent("paprwork_onboarding_step_viewed", {
        step_name: stage,
        gated: true,
      } as Record<string, unknown>);
    }
  }, [stage, devPreview]);

  // Runs exactly once, when Papr auth is confirmed — regardless of which
  // detection path (DOM event, IPC, poll, manual code) got us here.
  const handleSignedIn = useCallback(async () => {
    await identifyTelemetryAfterLogin();
    void useProfileStore.getState().loadProfile({ force: true });
    // Only meaningful once we have a session; failures leave it false, which
    // just means a returning user sees the recommend stage again.
    void fetchRemoteOnboarding().then((remote) => {
      if (remote?.completed) setAlreadyOnboarded(true);
    });
    setStage((current) => (current === "signin" ? "connect" : current));
  }, []);

  // Org setup can arrive from either transport; whichever lands first wins
  // and moves us off the sign-in stage.
  useEffect(() => {
    const receive = (request: OrgNamespaceSetupRequest) => {
      setSetupRequest(request);
      setStage("org");
    };

    const onDomEvent = (event: Event) => {
      receive((event as CustomEvent<OrgNamespaceSetupRequest>).detail);
    };

    window.addEventListener("papr-setup-required", onDomEvent);
    const papr = window.electronAPI?.papr;
    papr?.onSetupRequired(receive);

    return () => {
      window.removeEventListener("papr-setup-required", onDomEvent);
      papr?.removeSetupRequiredListener(receive);
    };
  }, []);

  if (stage === "org" && setupRequest) {
    return (
      <OrgNamespaceSetup
        request={setupRequest}
        source="auth_wall"
        onComplete={() => {
          setSetupRequest(null);
          setStage("connect");
        }}
      />
    );
  }

  if (stage === "recommend") {
    return (
      <RecommendStep
        onComplete={onComplete}
        previewMode={Boolean(devPreview)}
        onBack={() => {
          setReturnedToConnect(true);
          setStage("connect");
        }}
      />
    );
  }

  if (stage === "connect") {
    return (
      <ConnectAIStep
        // Connecting no longer ends setup — the recommend stage does, unless
        // this user already picked their first app on another machine.
        onDone={() => {
          // Coming back from recommend (or previewing) means they want the
          // recommend screen again — never jump straight into the app.
          if (!alreadyOnboarded || returnedToConnect || devPreview) {
            setStage("recommend");
            return;
          }
          // Finished on another machine — don't reopen the local intent picker.
          if (!devPreview) transitionTo("completed");
          onComplete();
        }}
        previewMode={Boolean(devPreview)}
        returning={returnedToConnect}
      />
    );
  }

  return (
    <AuthWall
      onSignedIn={handleSignedIn}
      skipAutoDetect={Boolean(devPreview)}
    />
  );
}
