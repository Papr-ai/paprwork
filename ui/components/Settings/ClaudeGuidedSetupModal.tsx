import { useEffect } from "react";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import { ClaudeOnboardingStepper } from "../Auth/ClaudeOnboardingStepper";
import "../Auth/onboardingTheme.css";
import "./ClaudeGuidedSetupModal.css";

interface ClaudeGuidedSetupModalProps {
  open: boolean;
  sessionKey: number;
  oauthSource: OAuthProviderSource;
  onClose: () => void;
  onConnected: () => void;
  onAskAgent: () => void;
}

export function ClaudeGuidedSetupModal({
  open,
  sessionKey,
  oauthSource,
  onClose,
  onConnected,
  onAskAgent,
}: ClaudeGuidedSetupModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="token-modal-backdrop claude-guided-setup-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="token-modal claude-guided-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-guided-setup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="token-modal__header claude-guided-setup-modal__header">
          <div>
            <h2 id="claude-guided-setup-title" className="token-modal__title">
              Let&apos;s set up Claude together
            </h2>
            <p className="claude-guided-setup-modal__lede">
              Same guided flow as onboarding — Papr can run checks and install steps for you.
            </p>
          </div>
          <button
            type="button"
            className="token-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="token-modal__body claude-guided-setup-modal__body onboarding-connect">
          <ClaudeOnboardingStepper
            key={sessionKey}
            oauthSource={oauthSource}
            onConnected={onConnected}
            onPickDifferent={onClose}
            onAskAgent={onAskAgent}
            pickDifferentLabel="Close"
          />
        </div>
      </div>
    </div>
  );
}
