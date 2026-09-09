import React, { useMemo, useState } from "react";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import {
  detectManualConnectionPlatform,
  getClaudeManualConnectionSteps,
  getTerminalLabel,
} from "../../constants/claudeManualConnection";
import { ClaudeTokenPastePanel } from "./ClaudeTokenPastePanel";
import "./ClaudeManualConnectionPanel.css";

interface ClaudeManualSetupPanelProps {
  oauthSource: OAuthProviderSource;
  onCancel: () => void;
  onConnected: () => void;
}

export function ClaudeManualSetupPanel({
  oauthSource,
  onCancel,
  onConnected,
}: ClaudeManualSetupPanelProps) {
  const platform = useMemo(() => detectManualConnectionPlatform(), []);
  const terminal = useMemo(() => getTerminalLabel(platform), [platform]);
  const steps = useMemo(() => getClaudeManualConnectionSteps(platform), [platform]);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(null), 2000);
    } catch {
      setCopiedCommand(null);
    }
  };

  return (
    <div className="claude-manual-connection">
      <p className="claude-manual-connection__intro">
        These commands run in {terminal} on your computer — not inside Paprwork.
        Copy each command, paste it into {terminal}, press Enter, then come back
        here to paste your sign-in token.
      </p>

      <ol className="claude-manual-connection__steps">
        {steps.map((step, index) => (
          <li key={step.title} className="claude-manual-connection__step">
            <div className="claude-manual-connection__step-header">
              <span className="claude-manual-connection__step-number">
                Step {index + 1}
              </span>
              <h4 className="claude-manual-connection__step-title">{step.title}</h4>
            </div>
            <p className="claude-manual-connection__step-desc">{step.description}</p>
            {step.command && (
              <>
                <div className="claude-manual-connection__command-row">
                  <pre className="claude-manual-connection__command">
                    {step.command}
                  </pre>
                  <button
                    type="button"
                    className="settings-btn settings-btn--secondary claude-manual-connection__copy-btn"
                    onClick={() => void handleCopyCommand(step.command ?? "")}
                  >
                    Copy
                  </button>
                </div>
                {copiedCommand === step.command && (
                  <p className="claude-manual-connection__copied">Copied</p>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      <ClaudeTokenPastePanel
        pasteMode="manual"
        oauthSource={oauthSource}
        onCancel={onCancel}
        onConnected={onConnected}
        hideIntro
      />
    </div>
  );
}
