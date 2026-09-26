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
import { ApiKeyStep } from "./ApiKeyStep";
import "./onboardingTheme.css";
import "./ConnectAIStep.css";

type ProviderId = "anthropic" | "openai";
type Stage = "pick" | "connecting" | "recover" | "apikey";

interface OAuthStatus {
  connected?: boolean;
  isExpired?: boolean;
  canRenew?: boolean;
}

/** Expired-but-renewable tokens refresh on the next request — still usable. */
const isUsable = (s: OAuthStatus | null | undefined): boolean =>
  Boolean(s?.connected && (!s.isExpired || s.canRenew));

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
  /**
   * User came BACK here from a later step. Don't auto-advance just because a
   * provider is connected — show the picker with a Continue instead.
   */
  returning?: boolean;
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
  returning = false,
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
  const [connected, setConnected] = useState<Record<ProviderId, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
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
    let cancelled = false;
    void (async () => {
      const [claude, openai] = await Promise.all([
        window.electronAPI.oauth.claude.getStatus().catch(() => null),
        window.electronAPI.oauth.openai.getStatus().catch(() => null),
      ]);
      if (cancelled) return;
      // Track BOTH — the old check stopped at the first one, so ChatGPT never
      // showed as connected whenever Claude was.
      const next = { anthropic: isUsable(claude), openai: isUsable(openai) };
      setConnected(next);
      if ((next.anthropic || next.openai) && !previewMode && !returning) {
        markModelConnected();
        onDone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onDone, previewMode, returning]);

  const succeed = useCallback(
    (id: ProviderId) => {
      stopPolling();
      markModelConnected();
      trackEvent("paprwork_onboarding_step_completed", {
        step_name: "connect_model",
        provider: id,
      } as Record<string, unknown>);
      // Nothing to confirm — they just watched it succeed. Move on.
      onDone();
    },
    [onDone, stopPolling],
  );

  // Don't rely on polling alone — the main process pushes the OAuth result.
  useEffect(() => {
    if (stage !== "connecting" || !provider) return;
    const off = window.electronAPI.oauth.onAuthStatus?.((data) => {
      if (data.provider !== provider) return;
      if (data.status === "connected") {
        succeed(provider);
        return;
      }
      stopPolling();
      setError(data.error || "The sign-in didn't finish.");
      setStage("recover");
    });
    return () => off?.();
  }, [provider, stage, stopPolling, succeed]);

  const handleCheckNow = useCallback(async () => {
    if (!provider) return;
    setCheckMsg(null);
    const status = await api(provider).getStatus().catch(() => null);
    if (isUsable(status)) {
      succeed(provider);
      return;
    }
    setCheckMsg("Not connected yet. Finish signing in in your browser, then check again.");
  }, [api, provider, succeed]);

  const backToPick = useCallback(() => {
    stopPolling();
    setError(null);
    setCheckMsg(null);
    setConfirmSkip(false);
    setStage("pick");
  }, [stopPolling]);

  const handleConnect = useCallback(
    async (id: ProviderId) => {
      // Already connected: the card is the "continue" button.
      if (connected[id]) {
        markModelConnected();
        onDone();
        return;
      }
      setProvider(id);
      setStage("connecting");
      setError(null);
      setCheckMsg(null);
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
          // No usable token on this Mac. The "automatic" path only opens a
          // Terminal whose token must be pasted back — nothing to wait on — so
          // go straight to the guided steps, which own the paste.
          setStage("recover");
          return;
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
              if (isUsable(status)) {
                succeed(id);
              } else if (waited >= 180) {
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
    [api, connected, onDone, stopPolling, succeed],
  );

  const finishWithoutSubscription = useCallback(
    (reason: "skip" | "api_key") => {
      stopPolling();
      transitionTo("recommend", { modelConnected: false });
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
    stopPolling();
    setError(null);
    setConfirmSkip(false);
    setStage("apikey");
  }, [stopPolling]);

  const handleApiKeySaved = useCallback(() => {
    markModelConnected();
    trackEvent("paprwork_onboarding_step_completed", {
      step_name: "connect_model",
      provider: "api_key",
    } as Record<string, unknown>);
    onDone();
  }, [onDone]);

  if (stage === "recover" && provider === "anthropic") {
    return (
      <div className="onboarding-flow onboarding-screen connect-ai--claude-stepper">
        <div className="onboarding-screen-inner onboarding-screen-inner--wide">
          <div className="onboarding-head-row">
            <AuthProgressDots activeIndex={2} />
            <button type="button" className="onboarding-skip-btn" onClick={handleSkip}>
              {confirmSkip ? "Yes — skip for now" : "Skip for now"}
            </button>
          </div>
          <h1 className="onboarding-h1 onboarding-h1--small">
            Let&apos;s set up Claude together
          </h1>
          <p className="onboarding-lede">
            Claude isn&apos;t signed in on this Mac yet. Papr runs each step for you and checks
            it before moving on — except signing in, which only you can do.
          </p>
          <ClaudeOnboardingStepper
            oauthSource="onboarding"
            onConnected={() => succeed("anthropic")}
            onPickDifferent={backToPick}
            hideFooterLinks
          />
          <div className="onboarding-foot">
            <button type="button" className="onboarding-back-btn" onClick={backToPick}>
              ← Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  const name = provider === "openai" ? "ChatGPT" : "Claude";

  return (
    // Every stage shares the same shell: progress dots top-left, content
    // left-aligned, Back bottom-left — same as the Claude stepper and recommend.
    <div className="onboarding-flow onboarding-screen">
      <div className="onboarding-screen-inner">
        <div className="onboarding-head-row">
          <AuthProgressDots activeIndex={2} />
          <button type="button" className="onboarding-skip-btn" onClick={handleSkip}>
            {confirmSkip ? "Yes — skip for now" : "Skip for now"}
          </button>
        </div>

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
                  <span className="onboarding-opt__name">
                    {connected[p.id] ? `Continue with ${p.name}` : `Connect ${p.name}`}
                  </span>
                  <span className="onboarding-opt__sub">{p.sub}</span>
                  <span className="onboarding-opt__note">{p.note}</span>
                  <span
                    className={`onboarding-opt__time${connected[p.id] ? " onboarding-opt__time--ok" : ""}`}
                  >
                    {connected[p.id] ? "✓ Connected" : p.time}
                  </span>
                </button>
              ))}
            </div>
            <div className="onboarding-foot onboarding-foot--split">
              <button type="button" className="onboarding-link" onClick={handleUseApiKey}>
                Use an API key instead
              </button>
            </div>
          </>
        )}

        {stage === "connecting" && (
          <>
            <h1 className="onboarding-h1">Connecting to {name}</h1>
            <p className="onboarding-lede">
              {provider === "anthropic"
                ? "Checking whether Claude is already signed in on this Mac."
                : "We opened OpenAI in your browser. Sign in there with your ChatGPT account — this screen moves on by itself when you're done."}
            </p>
            <div className="onboarding-wait-row">
              <span className="onboarding-spinner onboarding-spinner--inline" />
              <span>
                {provider === "anthropic" ? "Checking…" : "Waiting for your sign-in…"}
              </span>
            </div>
            {provider === "openai" && (
              <button
                type="button"
                className="onboarding-cta onboarding-cta--ghost"
                onClick={() => void handleCheckNow()}
              >
                I&apos;ve signed in — check now
              </button>
            )}
            {checkMsg && <p className="onboarding-check-msg">{checkMsg}</p>}
            <div className="onboarding-foot onboarding-foot--split">
              <button type="button" className="onboarding-back-btn" onClick={backToPick}>
                ← Back
              </button>
            </div>
          </>
        )}

        {stage === "apikey" && (
          <>
            <ApiKeyStep onSaved={handleApiKeySaved} />
            <div className="onboarding-foot">
              <button type="button" className="onboarding-back-btn" onClick={backToPick}>
                ← Back
              </button>
            </div>
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
              <button type="button" className="onboarding-back-btn" onClick={backToPick}>
                ← Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
