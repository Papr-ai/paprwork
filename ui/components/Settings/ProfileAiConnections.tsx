/**
 * ProfileAiConnections — ChatGPT / Claude connection shortcuts on Profile tab
 */

import React from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./ProfileAiConnections.css";

type AiProviderId = "openai" | "anthropic";

interface ProviderConfig {
  id: AiProviderId;
  label: string;
  keyName: string;
}

const PROVIDERS: ProviderConfig[] = [
  { id: "openai", label: "ChatGPT", keyName: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Claude", keyName: "ANTHROPIC_API_KEY" },
];

function openAiModelsSettings() {
  window.dispatchEvent(
    new CustomEvent("papr:open-settings", { detail: { tab: "models" } }),
  );
}

export function ProfileAiConnections() {
  const { keys, loading } = useCustomKeys();

  const isConnected = (keyName: string): boolean =>
    keys.some((key) => key.name === keyName);

  return (
    <div className="profile-ai-connections">
      <span className="profile-ai-connections__label">Connected AI Models</span>
      <div className="profile-ai-connections__row">
        {PROVIDERS.map((provider) => {
          const connected = isConnected(provider.keyName);
          return (
            <button
              key={provider.id}
              type="button"
              className={`profile-ai-chip${connected ? " profile-ai-chip--connected" : ""}`}
              onClick={openAiModelsSettings}
              disabled={loading}
              title={connected ? `${provider.label} connected` : `Connect ${provider.label}`}
            >
              <span className={`profile-ai-chip__icon profile-ai-chip__icon--${provider.id}`}>
                <ProviderBrandIcon providerId={provider.id} size={14} onLightSurface />
              </span>
              <span className="profile-ai-chip__label">{provider.label}</span>
              <span className="profile-ai-chip__status">
                {loading ? "…" : connected ? "Connected" : "Connect"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
