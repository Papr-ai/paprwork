/**
 * ConnectAIStep — the third stage of <AuthFlow>.
 *
 * Replaces the old OnboardingView behaviour of punting to Settings: the
 * connection actually happens here, against the same OAuth IPC that the
 * Settings tab uses. Skipping is always possible, but costs one more click
 * once the user is mid-attempt — a card-view skip is free, a mid-stepper
 * skip asks them to confirm they meant it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent } from "../../lib/telemetry";
import { ProviderBrandIcon } from "../Settings/ProviderBrandIcon";
import { ClaudeOnboardingStepper } from "./ClaudeOnboardingStepper";
import { markModelConnected, transitionTo } from "../../utils/onboardingState";
import { AuthProgressDots } from "./AuthProgressDots";
import "./onboardingTheme.css";
import "./ConnectAIStep.css";

type ProviderId = "anthropic" | "openai";
type Stage = "pick" | "connecting" | "connected" | "recover";

interface ConnectAIStepProps {
  /** Called when the user is done here — connected or deliberately skipped. */
  onDone: () => void;
  /** Settings → Dev preview: do not auto-close when OAuth is already connected. */
  previewMode?: boolean;
  /**
   * Dev only: land on the Claude guided setup (recover path) immediately so you
   * can click through Run check / install / terminal / paste while connected.
   */
  devForceClaudeRecover?: boolean;
}

const PROVIDERS: Array<{
  id: ProviderId;
  name: string;
  sub: string;
  note: string;
  time: string;
}> = [
  {
    id: "anthropic",
    name: "Claude",
    sub: "Pro or Max subscription",
    note: "Best for building apps and writing the jobs that run them.",
    time: "~60 sec",
  },
  {
    id: "openai",
    name: "ChatGPT",
    sub: "Plus or Pro subscription",
    note: "Best for research, writing and day-to-day reasoning.",
    time: "~30 sec",
  },
];

export function ConnectAIStep({
  onDone,
  previewMode = false,
  devForceClaudeRecover = false,
}: ConnectAIStepProps) {
  const [stage, setStage] = useState<Stage>(() =>
    devForceClaudeRecover ? "recover" : "pick",
  );
  const [provider, setProvider] = useState<ProviderId | null>(() =>
    devForceClaudeRecover ? "anthropic" : null,
  );
  const [error, setError] = useState<string | null>(() =>
    devForceClaudeRecover
      ? "Dev preview: simulating a sign-in that never came back."
      : null,
  );
  const [confirmSkip, setConfirmSkip] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useCallback(
    (id: ProviderId) =>
      id === "anthropic"
        ? window.electronAPI.oauth.claude
        : window.electronAPI.oauth.openai,
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    trackEvent("paprwork_onboarding_step_viewed", {
      step_name: "connect_model",
    } as Record<string, unknown>);
  }, []);

  // If a subscription is already connected (reinstall, second device), don't
  // make them do it again — skip straight past this stage. Dev preview keeps
  // the screen visible so you can inspect the UI while logged in.
  useEffect(() => {
    if (previewMode) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [claude, openai] = await Promise.all([
        window.electronAPI.oauth.claude.getStatus().catch(() => null),
        window.electronAPI.oauth.openai.getStatus().catch(() => null),
      ]);
      const already =
        (claude?.connected && !claude.isExpired) ||
        (openai?.connected && !openai.isExpired);
      if (already && !cancelled) {
        markModelConnected();
        onDone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onDone, previewMode]);

  const succeed = useCallback(
    (id: ProviderId) => {
      stopPolling();
      markModelConnected();
      trackEvent("paprwork_onboarding_step_completed", {
        step_name: "connect_model",
        provider: id,
      } as Record<string, unknown>);
      setStage("connected");
    },
    [stopPolling],
  );

  const handleConnect = useCallback(
    async (id: ProviderId) => {
      setProvider(id);
      setStage("connecting");
      setError(null);
      trackEvent("paprwork_onboarding_open_models", { provider: id } as Record<
        string,
        unknown
      >);

      try {
        // Claude Code may already hold a token on this machine.
        if (id === "anthropic") {
          const synced = await window.electronAPI.oauth.claude
            .trySyncFromStorage({ source: "onboarding" })
            .catch(() => ({ success: false }));
          if (synced?.success) {
            succeed(id);
            return;
          }
        }

        const result = await api(id).startOAuth({ source: "onboarding" });
        if (!result.success) {
          setError(result.error || "Couldn't start the sign-in.");
          setStage("recover");
          return;
        }

        // The browser owns the flow from here; poll for the result.
        let waited = 0;
        pollRef.current = setInterval(() => {
          waited += 2;
          void api(id)
            .getStatus()
            .then((status) => {
              if (status?.connected && !status.isExpired) {
                succeed(id);
              } else if (waited >= 90) {
                stopPolling();
                setStage("recover");
              }
            })
            .catch(() => undefined);
        }, 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
        setStage("recover");
      }
    },
    [api, stopPolling, succeed],
  );

  const finishWithoutSubscription = useCallback(
    (reason: "skip" | "api_key") => {
      stopPolling();
      transitionTo("choose_intent", { modelConnected: false });
      trackEvent("paprwork_onboarding_skipped", {
        phase: "connect_model",
        stage,
        reason,
      } as Record<string, unknown>);
      onDone();
    },
    [onDone, stage, stopPolling],
  );

  const handleSkip = useCallback(() => {
    // Free at the card view; deliberate once they're mid-attempt.
    if (stage !== "pick" && !confirmSkip) {
      setConfirmSkip(true);
      return;
    }
    finishWithoutSubscription("skip");
  }, [confirmSkip, finishWithoutSubscription, stage]);

  const handleUseApiKey = useCallback(() => {
    finishWithoutSubscription("api_key");
  }, [finishWithoutSubscription]);

  if (stage === "recover" && provider === "anthropic") {
    return (
      <div className="onboarding-flow onboarding-screen connect-ai--claude-stepper">
        <div className="onboarding-screen-inner onboarding-screen-inner--wide">
          <div className="onboarding-head-row">
            <AuthProgressDots activeIndex={2} />
            <button type="button" className="onboarding-skip-btn" onClick={handleSkip}>
              {confirmSkip ? "Yes — skip for now" : "Skip this for now"}
            </button>
          </div>
          <h1 className="onboarding-h1 onboarding-h1--small">
            Let&apos;s set up Claude together
          </h1>
          <p className="onboarding-lede">
            The automatic connection did not finish. Papr will run each step for you and check
            the result before moving on — except the sign-in, which only you can do.
          </p>
          <ClaudeOnboardingStepper
            oauthSource="onboarding"
            onConnected={() => succeed("anthropic")}
            onPickDifferent={() => setStage("pick")}
          />
          <div className="onboarding-foot">
            <button type="button" className="onboarding-link" onClick={handleUseApiKey}>
              Use an API key instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  const name = provider === "openai" ? "ChatGPT" : "Claude";

  return (
    <div className="onboarding-flow onboarding-screen">
      <div
        className={`onboarding-screen-inner${
          stage === "connecting" || stage === "connected"
            ? " onboarding-screen-inner--center"
            : ""
        }`}
      >
        {(stage === "pick" || stage === "recover") && (
          <AuthProgressDots activeIndex={2} />
        )}

        {stage === "pick" && (
          <>
            <h1 className="onboarding-h1">Connect your AI subscription</h1>
            <p className="onboarding-lede">
              Use the plan you already pay for. No extra model cost.
            </p>
            <div className="onboarding-opts">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="onboarding-opt"
                  onClick={() => void handleConnect(p.id)}
                >
                  <span className="onboarding-opt__mk">
                    <ProviderBrandIcon providerId={p.id} size={22} onLightSurface />
                  </span>
                  <span className="onboarding-opt__name">Connect {p.name}</span>
                  <span className="onboarding-opt__sub">{p.sub}</span>
                  <span className="onboarding-opt__note">{p.note}</span>
                  <span className="onboarding-opt__time">{p.time}</span>
                </button>
              ))}
            </div>
            <div className="onboarding-foot onboarding-foot--split">
              <button type="button" className="onboarding-link" onClick={handleUseApiKey}>
                Use an API key instead
              </button>
              <button type="button" className="onboarding-link" onClick={handleSkip}>
                Skip for now
              </button>
            </div>
          </>
        )}

        {stage === "connecting" && (
          <>
            <div className="onboarding-spinner" />
            <h1 className="onboarding-h1">Connecting to {name}</h1>
            <p className="onboarding-lede">
              {provider === "anthropic"
                ? "Looking for Claude Code on this Mac, then opening your browser to sign in."
                : "Opening your browser to sign in with OpenAI."}
            </p>
            <p className="onboarding-muted">
              This usually takes about {provider === "anthropic" ? "40" : "20"} seconds.
            </p>
            <button type="button" className="onboarding-link" onClick={handleSkip}>
              {confirmSkip ? "Yes — skip for now" : "Skip for now"}
            </button>
          </>
        )}

        {stage === "connected" && (
          <>
            <div className="onboarding-okring" aria-hidden>
              ✓
            </div>
            <h1 className="onboarding-h1">Connected to {name}</h1>
            <p className="onboarding-lede">
              Signed in on your {name} plan. Papr will use your own subscription — no extra
              cost, no API key to manage.
            </p>
            <button type="button" className="onboarding-cta" onClick={onDone}>
              Continue
            </button>
          </>
        )}

        {stage === "recover" && (
          <>
            <h1 className="onboarding-h1">
              The {name} sign-in didn&apos;t come back
            </h1>
            <p className="onboarding-lede">
              {error ||
                "Papr opened your browser but never received the confirmation."}{" "}
              This is almost always one of three things.
            </p>
            <ul className="onboarding-causes">
              <li>
                <b>The tab was closed before it finished.</b> Try again and let it redirect
                on its own.
              </li>
              <li>
                <b>You were signed into a different account.</b> Sign out first, then retry.
              </li>
              <li>
                <b>Your plan does not include API-backed sign-in.</b> Free plans cannot connect
                this way.
              </li>
            </ul>
            <div className="onboarding-foot">
              <button
                type="button"
                className="onboarding-cta"
                onClick={() => provider && void handleConnect(provider)}
              >
                Try the browser sign-in again
              </button>
              <button type="button" className="onboarding-link" onClick={() => setStage("pick")}>
                Pick a different option
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
