import { useCallback, useMemo, useState } from "react";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import {
  buildClaudeManualAgentPrompt,
  CLAUDE_MANUAL_AGENT_MODEL_ID,
  detectManualConnectionPlatform,
} from "../../constants/claudeManualConnection";
import { getClaudeOnboardingSteps } from "../../constants/claudeOnboardingSteps";
import { ClaudeOnboardingTokenStep } from "./ClaudeOnboardingTokenStep";

interface ClaudeOnboardingStepperProps {
  oauthSource: OAuthProviderSource;
  onConnected: () => void;
  onPickDifferent: () => void;
  onAskAgent?: () => void;
  /** Settings modal uses "Close"; onboarding uses provider picker copy. */
  pickDifferentLabel?: string;
}

export function ClaudeOnboardingStepper({
  oauthSource,
  onConnected,
  onPickDifferent,
  onAskAgent,
  pickDifferentLabel = "Pick a different option",
}: ClaudeOnboardingStepperProps) {
  const steps = useMemo(() => getClaudeOnboardingSteps(), []);
  const stepCount = steps.length;

  const [stepIndex, setStepIndex] = useState(0);
  const [stepDone, setStepDone] = useState(() => Array<boolean>(stepCount).fill(false));
  const [okMessages, setOkMessages] = useState<(string | null)[]>(() =>
    Array<string | null>(stepCount).fill(null),
  );
  const [running, setRunning] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const completeStep = useCallback(
    (
      index: number,
      okMessage: string,
      alsoComplete: Array<{ index: number; okMessage: string }> = [],
    ) => {
      setStepDone((prev) => {
        const next = [...prev];
        next[index] = true;
        for (const item of alsoComplete) {
          if (item.index >= 0 && item.index < stepCount) {
            next[item.index] = true;
          }
        }
        return next;
      });
      setOkMessages((prev) => {
        const next = [...prev];
        next[index] = okMessage;
        for (const item of alsoComplete) {
          if (item.index >= 0 && item.index < stepCount) {
            next[item.index] = item.okMessage;
          }
        }
        return next;
      });
      setStepError(null);
      const skipTo = Math.max(
        index + 1,
        ...alsoComplete.map((item) => item.index + 1),
      );
      setStepIndex(Math.min(skipTo, stepCount - 1));
    },
    [stepCount],
  );

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCmd(command);
      window.setTimeout(() => {
        setCopiedCmd((current) => (current === command ? null : current));
      }, 2200);
    } catch {
      setCopiedCmd(null);
    }
  };

  const runActiveStep = async () => {
    const step = steps[stepIndex];
    if (!step || running) {
      return;
    }

    setRunning(true);
    setStepError(null);

    try {
      if (stepIndex === 0) {
        const result = await window.electronAPI.oauth.claude.onboardingRunCheck({
          source: oauthSource,
        });
        if (result.connected) {
          onConnected();
          return;
        }
        if ("okMessage" in result) {
          completeStep(
            0,
            result.okMessage,
            result.skipInstallStep
              ? [{ index: 1, okMessage: "Claude Code is already installed — skipped." }]
              : [],
          );
          return;
        }
        setStepError(result.error);
        return;
      }

      if (stepIndex === 1) {
        const result = await window.electronAPI.oauth.claude.onboardingInstallCli({
          source: oauthSource,
        });
        if (!result.success) {
          setStepError(result.error);
          return;
        }
        completeStep(1, result.okMessage);
        return;
      }

      if (stepIndex === 2) {
        const result = await window.electronAPI.oauth.claude.openSetupTokenTerminal({
          source: oauthSource,
        });
        if (!result.success) {
          setStepError(result.error);
          return;
        }
        completeStep(2, step.defaultOk);
      }
    } catch (error) {
      setStepError(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  };

  const handleAskAgent = () => {
    if (onAskAgent) {
      onAskAgent();
      return;
    }
    const platform = detectManualConnectionPlatform();
    window.dispatchEvent(
      new CustomEvent("papr-chat-open", {
        detail: {
          message: buildClaudeManualAgentPrompt(platform),
          model: CLAUDE_MANUAL_AGENT_MODEL_ID,
        },
      }),
    );
  };

  return (
    <>
      <div className="claude-stepper">
        {steps.map((step, index) => {
          const done = stepDone[index];
          const isActive = index === stepIndex && !done;
          const isIdle = !done && !isActive;
          const okText = okMessages[index] ?? step.defaultOk;

          if (isIdle) {
            return (
              <div key={step.title} className="claude-stepper__st claude-stepper__st--idle">
                <span className="claude-stepper__st-n">{index + 1}</span>
                <div className="claude-stepper__st-body">
                  <h3>{step.title}</h3>
                </div>
              </div>
            );
          }

          if (done) {
            return (
              <div key={step.title} className="claude-stepper__st claude-stepper__st--done">
                <span className="claude-stepper__st-n" aria-hidden>
                  ✓
                </span>
                <div className="claude-stepper__st-body">
                  <h3>{step.title}</h3>
                  <p className="claude-stepper__st-ok">{okText}</p>
                </div>
              </div>
            );
          }

          const cmdLabel =
            step.mode === "run" ? "Papr runs this for you" : "Runs in Terminal on your computer";

          return (
            <div key={step.title} className="claude-stepper__st claude-stepper__st--active">
              <span className="claude-stepper__st-n">{index + 1}</span>
              <div className="claude-stepper__st-body">
                <h3>{step.title}</h3>
                <p>{step.body}</p>

                {step.cmd && (
                  <>
                    <p className="claude-stepper__cmd-label">{cmdLabel}</p>
                    <div className="claude-stepper__cmd">
                      <code>{step.cmd}</code>
                      <button
                        type="button"
                        className={`claude-stepper__copy${copiedCmd === step.cmd ? " claude-stepper__copy--ok" : ""}`}
                        onClick={() => void handleCopyCommand(step.cmd ?? "")}
                      >
                        {copiedCmd === step.cmd ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </>
                )}

                {step.mode === "paste" ? (
                  <ClaudeOnboardingTokenStep
                    oauthSource={oauthSource}
                    running={running}
                    onRunningChange={setRunning}
                    onConnected={onConnected}
                    onStepError={setStepError}
                  />
                ) : (
                  <div className="claude-stepper__st-actions">
                    {running ? (
                      <div className="claude-stepper__running" aria-live="polite">
                        <span className="claude-stepper__running-dot" aria-hidden />
                        {step.running}…
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="onboarding-cta onboarding-cta--small"
                        onClick={() => void runActiveStep()}
                      >
                        {step.action}
                      </button>
                    )}
                    {step.mode === "run" && step.cmd && !running && (
                      <button
                        type="button"
                        className="onboarding-link claude-stepper__run-self"
                        onClick={() => void handleCopyCommand(step.cmd ?? "")}
                      >
                        I would rather run it myself
                      </button>
                    )}
                  </div>
                )}

                {stepError && isActive && (
                  <p className="claude-stepper__error" role="alert">
                    {stepError}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="onboarding-foot onboarding-foot--split claude-stepper__foot">
        <button type="button" className="onboarding-link" onClick={handleAskAgent}>
          Have an agent walk me through it
        </button>
        <button type="button" className="onboarding-link" onClick={onPickDifferent}>
          {pickDifferentLabel}
        </button>
      </div>
    </>
  );
}
