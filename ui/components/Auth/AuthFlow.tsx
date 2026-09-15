/**
 * AuthFlow — host for the continuous pre-app onboarding flow.
 *
 *   signin (AuthWall) → org (OrgNamespaceSetup) → connect (ConnectAIStep) → app
 *
 * Owns the stage machine, the org-setup request listeners, and the single
 * "you are now authenticated" side effect. Children are presentational steps
 * that report upward — they do not decide what comes next.
 */

import { useCallback, useEffect, useState } from "react";
import { setTelemetryPaprUserId } from "../../lib/telemetry";
import { useProfileStore } from "../../stores/profileStore";
import { AuthWall } from "./AuthWall";
import {
  OrgNamespaceSetup,
  type OrgNamespaceSetupRequest,
} from "./OrgNamespaceSetup";
import { ConnectAIStep } from "./ConnectAIStep";

export type AuthFlowStage = "signin" | "org" | "connect";

interface AuthFlowProps {
  /** Called once the user has cleared every pre-app stage. */
  onComplete: () => void;
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

export function AuthFlow({ onComplete }: AuthFlowProps) {
  const [stage, setStage] = useState<AuthFlowStage>("signin");
  const [setupRequest, setSetupRequest] =
    useState<OrgNamespaceSetupRequest | null>(null);

  // Runs exactly once, when Papr auth is confirmed — regardless of which
  // detection path (DOM event, IPC, poll, manual code) got us here.
  const handleSignedIn = useCallback(async () => {
    await identifyTelemetryAfterLogin();
    void useProfileStore.getState().loadProfile({ force: true });
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

  if (stage === "connect") {
    return <ConnectAIStep onDone={onComplete} />;
  }

  return <AuthWall onSignedIn={handleSignedIn} />;
}
