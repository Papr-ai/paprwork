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
import { ClaudeManualSetupPanel } from "../Settings/ClaudeManualSetupPanel";
import { markModelConnected, transitionTo } from "../../utils/onboardingState";
import "./ConnectAIStep.css";

type ProviderId = "anthropic" | "openai";
type Stage = "pick" | "connecting" | "connected" | "recover";

interface ConnectAIStepProps {
  /** Called when the user is done here — connected or deliberately skipped. */
  onDone: () => void;
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
    note: "Uses the plan you already pay for. No API key, no extra model cost.",
    time: "about 40 seconds",
  },
  {
    id: "openai",
    name: "ChatGPT",
    sub: "Plus or Pro subscription",
    note: "Signs in through your browser. Free plans can't connect this way.",
    time: "about 20 seconds",
  },
];

export function ConnectAIStep({ onDone }: ConnectAIStepProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  // make them do it again — skip straight past this stage.
  useEffect(() => {
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
  }, [onDone]);

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

  const handleSkip = useCallback(() => {
    // Free at the card view; deliberate once they're mid-attempt.
    if (stage !== "pick" && !confirmSkip) {
      setConfirmSkip(true);
      return;
    }
    stopPolling();
    transitionTo("choose_intent", { modelConnected: false });
    trackEvent("paprwork_onboarding_skipped", {
      phase: "connect_model",
      stage,
    } as Record<string, unknown>);
    onDone();
  }, [confirmSkip, onDone, stage, stopPolling]);

  if (stage === "recover" && provider === "anthropic") {
    return (
      <div className="connect-ai connect-ai--panel">
        <ClaudeManualSetupPanel
          oauthSource="onboarding"
          onCancel={() => setStage("pick")}
          onConnected={() => succeed("anthropic")}
        />
        <button type="button" className="connect-ai-link" onClick={handleSkip}>
          {confirmSkip ? "Yes — skip for now" : "Skip for now"}
        </button>
      </div>
    );
  }

  const name = provider === "openai" ? "ChatGPT" : "Claude";

  return (
    <div className="connect-ai">
      <div className="connect-ai-inner">
        {stage === "pick" && (
          <>
            <h1 className="connect-ai-title">Connect your AI subscription</h1>
            <p className="connect-ai-lede">
              Use the plan you already pay for. No extra model cost.
            </p>
            <div className="connect-ai-options">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="connect-ai-option"
                  onClick={() => void handleConnect(p.id)}
                >
                  <span className="connect-ai-option__brand">
                    <ProviderBrandIcon providerId={p.id} size={22} onLightSurface />
                  </span>
                  <span className="connect-ai-option__name">
                    Connect {p.name}
                  </span>
                  <span className="connect-ai-option__sub">{p.sub}</span>
                  <span className="connect-ai-option__note">{p.note}</span>
                  <span className="connect-ai-option__time">{p.time}</span>
                </button>
              ))}
            </div>
            <div className="connect-ai-foot">
              <button
                type="button"
                className="connect-ai-link"
                onClick={handleSkip}
              >
                Skip for now
              </button>
            </div>
          </>
        )}

        {stage === "connecting" && (
          <div className="connect-ai-center">
            <div className="connect-ai-spinner" />
            <h1 className="connect-ai-title">Connecting to {name}</h1>
            <p className="connect-ai-lede">
              {provider === "anthropic"
                ? "Looking for Claude Code on this Mac, then opening your browser to sign in."
                : "Opening your browser to sign in with OpenAI."}
            </p>
            <p className="connect-ai-muted">
              Finish in the browser and come back — this screen updates itself.
            </p>
            <button
              type="button"
              className="connect-ai-link"
              onClick={handleSkip}
            >
              {confirmSkip ? "Yes — skip for now" : "Skip for now"}
            </button>
          </div>
        )}

        {stage === "connected" && (
          <div className="connect-ai-center">
            <div className="connect-ai-check">✓</div>
            <h1 className="connect-ai-title">Connected to {name}</h1>
            <p className="connect-ai-lede">
              Papr will use your own subscription — no extra cost, no API key to
              manage.
            </p>
            <button type="button" className="connect-ai-cta" onClick={onDone}>
              Continue
            </button>
          </div>
        )}

        {stage === "recover" && (
          <>
            <h1 className="connect-ai-title">
              The {name} sign-in didn&apos;t come back
            </h1>
            <p className="connect-ai-lede">
              {error ||
                "Papr opened your browser but never received the confirmation."}{" "}
              This is usually one of three things.
            </p>
            <ul className="connect-ai-causes">
              <li>
                <b>The tab closed before it finished.</b> Try again and let it
                redirect on its own.
              </li>
              <li>
                <b>You were signed into a different account.</b> Sign out first,
                then retry.
              </li>
              <li>
                <b>Your plan doesn&apos;t include this.</b> Free plans can&apos;t
                connect a subscription.
              </li>
            </ul>
            <div className="connect-ai-foot">
              <button
                type="button"
                className="connect-ai-cta"
                onClick={() => provider && void handleConnect(provider)}
              >
                Try the sign-in again
              </button>
              <button
                type="button"
                className="connect-ai-link"
                onClick={() => setStage("pick")}
              >
                Pick a different option
              </button>
              <button
                type="button"
                className="connect-ai-link"
                onClick={handleSkip}
              >
                {confirmSkip ? "Yes — skip for now" : "Skip for now"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
