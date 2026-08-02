/**
 * AIModelsTab - AI model configuration: provider keys, OAuth, and model picker
 */

import React, { useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { trackEvent } from "../../lib/telemetry";
import { OAuthSection } from "./OAuthSection";
import { ModelPickerSettings } from "./ModelPickerSettings";
import { AgentContextSettingsModal } from "./AgentContextSettingsModal";

interface AIModelsTabProps {
  scrollToPickerModels?: boolean;
}

export function AIModelsTab({ scrollToPickerModels = false }: AIModelsTabProps) {
  const { keys, loading, addKey, updateKey, deleteKey, getKeyValue } = useCustomKeys();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [showKeyValue, setShowKeyValue] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [showAgentContextModal, setShowAgentContextModal] = useState(false);

  const getProviderStatus = (keyName: string) => {
    const key = keys.find((k) => k.name === keyName);
    return {
      hasKey: !!key,
      isOAuth: key?.managedBy === "oauth",
    };
  };

  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      keyName: "OPENAI_API_KEY",
      hint: "platform.openai.com/api-keys",
      hasOAuth: true,
      subscriptionName: "ChatGPT Plus/Pro",
      models: ["GPT-5.4", "GPT-5.4 Mini", "GPT-5.3 Codex"],
    },
    {
      id: "anthropic",
      name: "Claude",
      keyName: "ANTHROPIC_API_KEY",
      hint: "console.anthropic.com",
      hasOAuth: true,
      subscriptionName: "Claude Pro/Max",
      models: ["Claude Opus 4", "Claude Sonnet 4", "Claude Haiku 4.5"],
    },
    {
      id: "google",
      name: "Google",
      keyName: "GOOGLE_API_KEY",
      hint: "makersuite.google.com/app/apikey",
      hasOAuth: false,
      subscriptionName: "",
      models: ["Gemini 3 Pro", "Gemini 2.5 Flash", "Gemini 3 Flash"],
    },
  ];

  const handleSaveApiKey = async (keyName: string) => {
    const value = apiKeyInputs[keyName]?.trim();
    if (!value) return;
    setSavingKey(keyName);
    try {
      const existing = keys.find((k) => k.name === keyName);
      if (existing) {
        await updateKey(existing.id, { name: keyName, value, permission: "always" });
      } else {
        await addKey({ name: keyName, value, permission: "always" });
      }
      setApiKeyInputs((prev) => ({ ...prev, [keyName]: "" }));
      if (!localStorage.getItem("papr-activation-model-connected")) {
        localStorage.setItem("papr-activation-model-connected", "true");
        trackEvent("paprwork_activation_model_connected", { provider: keyName } as Record<
          string,
          unknown
        >);
      }
      setExpandedProvider(null);
    } catch (err) {
      console.error("Failed to save key:", err);
    } finally {
      setSavingKey(null);
    }
  };

  const handleRemoveApiKey = async (keyName: string) => {
    const key = keys.find((k) => k.name === keyName);
    if (key && confirm(`Remove ${keyName}?`)) {
      await deleteKey(key.id);
    }
  };

  const handleLoadKeyValue = async (keyName: string) => {
    const key = keys.find((k) => k.name === keyName);
    if (!key) return;
    try {
      const value = await getKeyValue(key.id);
      setApiKeyInputs((prev) => ({ ...prev, [keyName]: value ?? "" }));
      setShowKeyValue((prev) => ({ ...prev, [keyName]: true }));
    } catch {
      // ignore
    }
  };

  return (
    <div className="settings-content settings-content--full-width">
      <div className="settings-section">
        <h2 className="settings-section__title">AI Models</h2>
        <p className="settings-section__description">
          Connect your AI providers and choose which models appear in chat.
        </p>
      </div>

      {/* Provider Cards */}
      <div className="ai-providers-grid">
        {providers.map((provider) => {
          const status = getProviderStatus(provider.keyName);
          const isExpanded = expandedProvider === provider.id;

          return (
            <div key={provider.id} className="ai-provider-card">
              <div className="ai-provider-card__header">
                <h3 className="ai-provider-card__name">{provider.name}</h3>
                {status.hasKey ? (
                  <span className="ai-provider-badge ai-provider-badge--connected">
                    ✓ {status.isOAuth ? "OAuth" : "API Key"}
                  </span>
                ) : (
                  <span className="ai-provider-badge ai-provider-badge--none">
                    Not configured
                  </span>
                )}
              </div>

              <div className="ai-provider-card__models">
                {provider.models.join(" · ")}
              </div>

              {provider.hasOAuth && (
                <OAuthSection
                  provider={provider.id as "openai" | "anthropic"}
                  title={provider.name}
                  subscriptionName={provider.subscriptionName}
                  apiKeyName={provider.keyName}
                  apiKeyHint={provider.hint}
                />
              )}

              {!provider.hasOAuth && (
                <div className="ai-provider-card__apikey">
                  {status.hasKey ? (
                    <div className="ai-provider-key-status">
                      <span className="ai-provider-key-masked">••••••••</span>
                      <div className="ai-provider-key-actions">
                        <button
                          className="settings-btn settings-btn--small"
                          onClick={() => {
                            setExpandedProvider(isExpanded ? null : provider.id);
                            if (!isExpanded) handleLoadKeyValue(provider.keyName);
                          }}
                        >
                          {isExpanded ? "Cancel" : "Edit"}
                        </button>
                        <button
                          className="settings-btn settings-btn--small settings-btn--danger"
                          onClick={() => handleRemoveApiKey(provider.keyName)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="settings-btn settings-btn--secondary"
                      onClick={() => setExpandedProvider(isExpanded ? null : provider.id)}
                      style={{ width: "100%" }}
                    >
                      {isExpanded ? "Cancel" : "Add API Key"}
                    </button>
                  )}

                  {isExpanded && (
                    <div className="ai-provider-key-input">
                      <input
                        type={showKeyValue[provider.keyName] ? "text" : "password"}
                        className="form-input"
                        placeholder={`Enter ${provider.keyName}`}
                        value={apiKeyInputs[provider.keyName] || ""}
                        onChange={(e) =>
                          setApiKeyInputs((prev) => ({
                            ...prev,
                            [provider.keyName]: e.target.value,
                          }))
                        }
                      />
                      <div className="ai-provider-key-input-actions">
                        <button
                          className="settings-btn settings-btn--small"
                          onClick={() =>
                            setShowKeyValue((prev) => ({
                              ...prev,
                              [provider.keyName]: !prev[provider.keyName],
                            }))
                          }
                        >
                          {showKeyValue[provider.keyName] ? "Hide" : "Show"}
                        </button>
                        <button
                          className="settings-btn settings-btn--primary settings-btn--small"
                          onClick={() => handleSaveApiKey(provider.keyName)}
                          disabled={
                            !apiKeyInputs[provider.keyName]?.trim() ||
                            savingKey === provider.keyName
                          }
                        >
                          {savingKey === provider.keyName ? "Saving..." : "Save"}
                        </button>
                      </div>
                      <p className="ai-provider-key-hint">{provider.hint}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ModelPickerSettings scrollIntoView={scrollToPickerModels} />

      <div className="settings-section agent-context-teaser">
        <div className="agent-context-teaser__row">
          <div>
            <h3 className="agent-context-teaser__title">Agent Context</h3>
            <p className="settings-section__description agent-context-teaser__description">
              Tool result truncation and context limits for long sessions.
            </p>
          </div>
          <button
            type="button"
            className="agent-context-teaser__link"
            onClick={() => setShowAgentContextModal(true)}
          >
            Adjust settings
          </button>
        </div>
      </div>

      {showAgentContextModal && (
        <AgentContextSettingsModal onClose={() => setShowAgentContextModal(false)} />
      )}
    </div>
  );
}
