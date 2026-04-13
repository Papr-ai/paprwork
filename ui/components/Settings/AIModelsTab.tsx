/**
 * AIModelsTab - AI model configuration with Papr AI proxy toggle + provider cards
 * "I want AI to work" — one toggle for instant access, or bring your own keys
 */

import React, { useState, useEffect } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { OAuthSection } from "./OAuthSection";
import { PaprLoginSection } from "./PaprLoginSection";
import { gateway } from "../../src/lib/gateway";

interface PaprAIStatus {
  enabled: boolean;
  loading: boolean;
}

export function AIModelsTab() {
  const { keys, loading, addKey, updateKey, deleteKey, getKeyValue, loadKeys } = useCustomKeys();
  const [paprAI, setPaprAI] = useState<PaprAIStatus>({ enabled: false, loading: true });
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [showKeyValue, setShowKeyValue] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Check if user is logged into Papr (required for proxy)
  const paprKey = keys.find(k => k.name === "PAPR_API_KEY");
  const hasPaprKey = !!paprKey;

  // Load Papr AI proxy preference
  useEffect(() => {
    loadPaprAIStatus();
  }, []);

  const loadPaprAIStatus = async () => {
    try {
      const settings = await gateway.send("settings:get", {});
      setPaprAI({
        enabled: settings?.paprAIProxy?.enabled ?? false,
        loading: false,
      });
    } catch {
      setPaprAI({ enabled: false, loading: false });
    }
  };

  const togglePaprAI = async () => {
    const newEnabled = !paprAI.enabled;
    setPaprAI(prev => ({ ...prev, enabled: newEnabled }));
    try {
      await gateway.send("settings:save-ui-preferences", {
        paprAIProxy: { enabled: newEnabled },
      });
    } catch {
      setPaprAI(prev => ({ ...prev, enabled: !newEnabled }));
    }
  };

  const getProviderStatus = (keyName: string) => {
    const key = keys.find(k => k.name === keyName);
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
      const existing = keys.find(k => k.name === keyName);
      if (existing) {
        await updateKey(existing.id, { name: keyName, value, permission: "always" });
      } else {
        await addKey({ name: keyName, value, permission: "always" });
      }
      setApiKeyInputs(prev => ({ ...prev, [keyName]: "" }));
      setExpandedProvider(null);
    } catch (err) {
      console.error("Failed to save key:", err);
    } finally {
      setSavingKey(null);
    }
  };

  const handleRemoveApiKey = async (keyName: string) => {
    const key = keys.find(k => k.name === keyName);
    if (key && confirm(`Remove ${keyName}?`)) {
      await deleteKey(key.id);
    }
  };

  const handleLoadKeyValue = async (keyName: string) => {
    const key = keys.find(k => k.name === keyName);
    if (!key) return;
    try {
      const value = await getKeyValue(key.id);
      setApiKeyInputs(prev => ({ ...prev, [keyName]: value ?? "" }));
      setShowKeyValue(prev => ({ ...prev, [keyName]: true }));
    } catch {
      // ignore
    }
  };

  return (
    <div className="settings-content settings-content--full-width">
      {/* Papr Login / Account Section */}

        <div className="settings-section">
          <PaprLoginSection onApiKeyReceived={() => loadKeys()} />
        </div>

      {/* Hero: Papr AI Proxy Toggle */}
      <div className="settings-section">
        <div className="ai-proxy-card">
          <div className="ai-proxy-card__header">
            <div className="ai-proxy-card__info">
              <div className="ai-proxy-card__icon">⚡</div>
              <div>
                <h3 className="ai-proxy-card__title">Use AI via Papr</h3>
                <p className="ai-proxy-card__description">
                  Use GPT, Claude & Gemini through your Papr account — no API keys needed.
                </p>
              </div>
            </div>
            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={paprAI.enabled}
                onChange={togglePaprAI}
                disabled={!hasPaprKey || paprAI.loading}
              />
              <span className="ai-toggle__slider" />
            </label>
          </div>

          {!hasPaprKey && (
            <p className="ai-proxy-card__note">
              Login to Papr above to enable this feature.
            </p>
          )}

          {paprAI.enabled && hasPaprKey && (
            <div className="ai-proxy-card__active">
              <span className="ai-proxy-card__active-dot" />
              AI requests are routed through your Papr account
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="ai-divider">
        <span className="ai-divider__text">or bring your own keys</span>
      </div>

      {/* Priority explanation */}
      <p className="ai-priority-note">
        Priority: Own API key → OAuth → Papr AI
      </p>

      {/* Provider Cards */}
      <div className="ai-providers-grid">
        {providers.map(provider => {
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
                ) : paprAI.enabled ? (
                  <span className="ai-provider-badge ai-provider-badge--proxy">
                    via Papr
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

              {/* OAuth section for OpenAI/Claude */}
              {provider.hasOAuth && (
                <OAuthSection
                  provider={provider.id as "openai" | "anthropic"}
                  title={provider.name}
                  subscriptionName={provider.subscriptionName}
                  apiKeyName={provider.keyName}
                  apiKeyHint={provider.hint}
                />
              )}

              {/* API Key section for Google (no OAuth) */}
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
                        onChange={e =>
                          setApiKeyInputs(prev => ({
                            ...prev,
                            [provider.keyName]: e.target.value,
                          }))
                        }
                      />
                      <div className="ai-provider-key-input-actions">
                        <button
                          className="settings-btn settings-btn--small"
                          onClick={() =>
                            setShowKeyValue(prev => ({
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
                          disabled={!apiKeyInputs[provider.keyName]?.trim() || savingKey === provider.keyName}
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
    </div>
  );
}
