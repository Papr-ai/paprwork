/**
 * ImportSetupWizard - Pre-import modal that guides users through
 * key configuration and service substitution before importing a
 * community app bundle.
 *
 * Three steps:
 *   1. Overview — shows required integrations + status (connected / missing)
 *   2. Setup   — per-key: paste key, open signup, or pick alternative service
 *   3. Confirm — summary of what will happen, then hand off to agent chat
 */

import { useState, useEffect, useCallback } from "react";
import type { RequiredKeySpec } from "../../../src/core/types/bundles";
import {
  normalizeRequirements,
  type RequirementItem,
} from "../../../src/core/types/bundles";
import {
  lookupService,
  getAlternatives,
} from "../../../src/core/data/knownServices";
import {
  findSimilarKeys,
  isOptionalLLMKey,
  type SimilarKey,
} from "../../../src/core/utils/keySimilarity";
import type { CustomKeyInput } from "../../types/settings";
import "./ImportSetupWizard.css";

// ─── SVG icon helpers (no emojis) ────────────────────────────────────

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function HelpCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function AppDefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  );
}

// ─── Types ───────────────────────────────────────────────────────────

interface WizardEntry {
  spec: RequiredKeySpec;
  status: "connected" | "missing" | "optional";
  configuredKeyValue?: string;
  substitution?: {
    originalService: string;
    chosenService: string;
    chosenKeyName: string;
    keyValue: string;
  };
  similarKeys?: SimilarKey[]; // Similar existing keys user might want to use
  selectedSimilarKey?: string; // Key name user selected from similar keys
}

export interface WizardResult {
  configured: Array<{ keyName: string; service: string }>;
  substituted: Array<{
    originalKeyName: string;
    originalService: string;
    chosenKeyName: string;
    chosenService: string;
  }>;
  skipped: Array<{ keyName: string; service: string }>;
}

export interface HelpRequest {
  service: string;
  keyName: string;
  instructions?: string;
  signupUrl?: string;
  docsUrl?: string;
}

interface ImportSetupWizardProps {
  appName: string;
  appDescription?: string;
  appIcon?: string;
  requirements: RequirementItem[];
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
  onRequestHelp?: (request: HelpRequest) => void;
}

type Step = "overview" | "setup" | "confirm";

// ─── Component ───────────────────────────────────────────────────────

export function ImportSetupWizard({
  appName,
  appDescription,
  appIcon,
  requirements,
  onComplete,
  onCancel,
  onRequestHelp,
}: ImportSetupWizardProps) {
  const [step, setStep] = useState<Step>("overview");
  const [entries, setEntries] = useState<WizardEntry[]>([]);
  const [currentKeyIdx, setCurrentKeyIdx] = useState(0);
  const [keyInput, setKeyInput] = useState("");
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [selectedAlt, setSelectedAlt] = useState<string | null>(null);
  const [customServiceName, setCustomServiceName] = useState("");
  const [altKeyInput, setAltKeyInput] = useState("");

  // Normalize requirements and check existing keys on mount
  useEffect(() => {
    void loadInitialState();
  }, [requirements]);

  const loadInitialState = useCallback(async () => {
    const specs = normalizeRequirements(requirements);

    // Enrich bare specs with known service metadata
    const enriched = specs.map((spec) => {
      const known = lookupService(spec.name);
      if (known && spec.service === spec.name) {
        return {
          ...spec,
          service: known.service,
          category: known.category,
          description: known.description,
          signupUrl: known.signupUrl,
          docsUrl: known.docsUrl,
          instructions: known.instructions,
          freeTier: known.freeTier,
          freeTierNote: known.freeTierNote,
        };
      }
      return spec;
    });

    let keys: Array<{ name: string }> = [];
    try {
      if (window.electronAPI?.customKeys) {
        keys = (await window.electronAPI.customKeys.list({ orgOnly: true })) as Array<{ name: string }>;
      }
    } catch {
      // May not be in Electron context
    }

    const keyNameSet = new Set(keys.map((k) => k.name));
    const existingKeyNames = Array.from(keyNameSet);
    
    const wizardEntries: WizardEntry[] = enriched.map((spec) => {
      const isConnected = keyNameSet.has(spec.name);
      
      // Check if this is an LLM provider key (can use OAuth/Papr proxy)
      const isLLMKey = isOptionalLLMKey(spec.name);
      
      // Find similar keys if not connected
      let similarKeys: SimilarKey[] = [];
      if (!isConnected && existingKeyNames.length > 0) {
        similarKeys = findSimilarKeys(spec.name, existingKeyNames, 0.6);
      }
      
      // Determine status
      let status: "connected" | "missing" | "optional";
      if (isConnected) {
        status = "connected";
      } else if (isLLMKey || !spec.required) {
        status = "optional";
      } else {
        status = "missing";
      }
      
      return {
        spec,
        status,
        similarKeys,
      };
    });

    setEntries(wizardEntries);
  }, [requirements]);

  // Keys that still need configuration (missing required + optional missing)
  const missingEntries = entries.filter((e) => e.status !== "connected");
  const missingRequired = entries.filter((e) => e.status === "missing");
  const allConfigured = missingRequired.length === 0;

  const currentEntry = missingEntries[currentKeyIdx];

  // Step indicator
  const stepIndex = step === "overview" ? 0 : step === "setup" ? 1 : 2;
  const stepDots = (
    <div className="isw-steps">
      <div className={`isw-step-dot ${stepIndex === 0 ? "isw-step-dot--active" : "isw-step-dot--completed"}`} />
      <div className={`isw-step-dot ${stepIndex === 1 ? "isw-step-dot--active" : stepIndex > 1 ? "isw-step-dot--completed" : ""}`} />
      <div className={`isw-step-dot ${stepIndex === 2 ? "isw-step-dot--active" : ""}`} />
    </div>
  );

  // Save a key to the keychain
  const saveKey = async (name: string, value: string, description?: string) => {
    try {
      if (!window.electronAPI?.customKeys) return;
      const input: CustomKeyInput = {
        name,
        value,
        description,
        permission: "always",
      };
      await window.electronAPI.customKeys.add(input);
    } catch (err) {
      console.error("[ImportSetupWizard] Failed to save key:", err);
    }
  };

  // Handle advancing from key setup
  const handleKeySubmit = async () => {
    if (!currentEntry) return;

    // If user selected a similar existing key, map it to the requested key name
    if (currentEntry.selectedSimilarKey) {
      // Mark as connected without saving a new key
      setEntries((prev) =>
        prev.map((e) =>
          e === currentEntry
            ? {
                ...e,
                status: "connected" as const,
                substitution: {
                  originalService: e.spec.service,
                  chosenService: e.spec.service,
                  chosenKeyName: e.selectedSimilarKey!,
                  keyValue: "", // Value already stored
                },
              }
            : e
        )
      );
    } else if (showAlternatives && selectedAlt && altKeyInput.trim()) {
      // Service substitution
      const altService = selectedAlt === "__custom__"
        ? customServiceName || "Custom Service"
        : selectedAlt;
      const altKeyName = selectedAlt === "__custom__"
        ? customServiceName.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY"
        : getAlternatives(currentEntry.spec.name).find(
            (a) => a.service === selectedAlt,
          )?.keyName ?? selectedAlt.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_KEY";

      await saveKey(
        altKeyName,
        altKeyInput.trim(),
        `${altService} key (substituted for ${currentEntry.spec.service})`,
      );

      setEntries((prev) =>
        prev.map((e) =>
          e === currentEntry
            ? {
                ...e,
                status: "connected" as const,
                substitution: {
                  originalService: e.spec.service,
                  chosenService: altService,
                  chosenKeyName: altKeyName,
                  keyValue: altKeyInput.trim(),
                },
              }
            : e,
        ),
      );
    } else if (keyInput.trim()) {
      // Direct key configuration
      await saveKey(
        currentEntry.spec.name,
        keyInput.trim(),
        `${currentEntry.spec.service} key`,
      );

      setEntries((prev) =>
        prev.map((e) =>
          e === currentEntry
            ? { ...e, status: "connected" as const, configuredKeyValue: keyInput.trim() }
            : e,
        ),
      );
    }

    // Reset inputs and advance
    setKeyInput("");
    setAltKeyInput("");
    setShowAlternatives(false);
    setSelectedAlt(null);
    setCustomServiceName("");

    if (currentKeyIdx < missingEntries.length - 1) {
      setCurrentKeyIdx((prev) => prev + 1);
    } else {
      setStep("confirm");
    }
  };

  const handleSkipKey = () => {
    setKeyInput("");
    setAltKeyInput("");
    setShowAlternatives(false);
    setSelectedAlt(null);
    setCustomServiceName("");

    if (currentKeyIdx < missingEntries.length - 1) {
      setCurrentKeyIdx((prev) => prev + 1);
    } else {
      setStep("confirm");
    }
  };

  const handleImport = () => {
    const result: WizardResult = {
      configured: [],
      substituted: [],
      skipped: [],
    };

    for (const entry of entries) {
      if (entry.substitution) {
        result.substituted.push({
          originalKeyName: entry.spec.name,
          originalService: entry.spec.service,
          chosenKeyName: entry.substitution.chosenKeyName,
          chosenService: entry.substitution.chosenService,
        });
      } else if (entry.status === "connected") {
        result.configured.push({
          keyName: entry.spec.name,
          service: entry.spec.service,
        });
      } else {
        result.skipped.push({
          keyName: entry.spec.name,
          service: entry.spec.service,
        });
      }
    }

    onComplete(result);
  };

  // ── Render app icon ──

  const renderAppIcon = () => {
    if (appIcon) {
      const trimmed = appIcon.trim();
      if (trimmed.startsWith("<")) {
        return (
          <div
            className="isw-app-orb-custom"
            dangerouslySetInnerHTML={{ __html: trimmed }}
          />
        );
      }
      return <div className="isw-app-orb-custom">{trimmed}</div>;
    }
    return (
      <div className="isw-app-orb">
        <AppDefaultIcon />
      </div>
    );
  };

  // ── Step 1: Overview ──

  const renderOverview = () => (
    <>
      <div className="isw-body">
        <div className="isw-section-label">Required integrations</div>
        {entries.map((entry) => (
          <div key={entry.spec.name} className="isw-integration-row">
            <div className="isw-integration-icon">
              <KeyIcon />
            </div>
            <div className="isw-integration-info">
              <div className="isw-integration-name">{entry.spec.service}</div>
              <div className="isw-integration-desc">
                {entry.spec.description || entry.spec.name}
              </div>
            </div>
            <span
              className={`isw-badge isw-badge--${entry.status}`}
            >
              {entry.status === "connected" && "Connected"}
              {entry.status === "missing" && "Not configured"}
              {entry.status === "optional" && (
                <>
                  Optional
                  {isOptionalLLMKey(entry.spec.name) && " (OAuth/Papr)"}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="isw-footer">
        <button className="isw-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        {allConfigured ? (
          <button className="isw-btn-primary" onClick={() => setStep("confirm")}>
            Import App
          </button>
        ) : (
          <button
            className="isw-btn-primary"
            onClick={() => {
              setCurrentKeyIdx(0);
              setStep("setup");
            }}
          >
            Set Up Integrations
          </button>
        )}
      </div>
    </>
  );

  // ── Step 2: Key setup ──

  const renderSetup = () => {
    if (!currentEntry) {
      setStep("confirm");
      return null;
    }

    const spec = currentEntry.spec;
    const known = lookupService(spec.name);
    const alternatives = getAlternatives(spec.name);
    const canSubmit = currentEntry.selectedSimilarKey
      ? true // Similar key selected
      : showAlternatives
        ? Boolean(selectedAlt && altKeyInput.trim())
        : Boolean(keyInput.trim());

    return (
      <>
        <div className="isw-body">
          {!showAlternatives ? (
            <>
              <div className="isw-key-header">
                <div className="isw-key-icon">
                  <KeyIcon />
                </div>
                <div>
                  <div className="isw-key-title">
                    {spec.service}
                    {spec.freeTier && (
                      <span className="isw-free-badge">Free tier</span>
                    )}
                  </div>
                  <div className="isw-key-subtitle">
                    {spec.freeTierNote ?? spec.description}
                  </div>
                </div>
              </div>

              {spec.instructions && (
                <div className="isw-instructions">
                  <strong>How to get your API key: </strong>
                  {spec.instructions}
                </div>
              )}
              
              {/* Show similar keys if any */}
              {currentEntry.similarKeys && currentEntry.similarKeys.length > 0 && (
                <div className="isw-similar-keys">
                  <div className="isw-similar-keys__header">
                    <strong>You already have similar keys:</strong>
                  </div>
                  <div className="isw-similar-keys__list">
                    {currentEntry.similarKeys.map((similar) => (
                      <button
                        key={similar.name}
                        className={`isw-similar-key-btn ${currentEntry.selectedSimilarKey === similar.name ? "isw-similar-key-btn--selected" : ""}`}
                        onClick={() => {
                          setEntries((prev) =>
                            prev.map((e) =>
                              e === currentEntry
                                ? { ...e, selectedSimilarKey: similar.name }
                                : e
                            )
                          );
                        }}
                      >
                        <div className="isw-similar-key-btn__name">{similar.name}</div>
                        <div className="isw-similar-key-btn__reason">{similar.reason}</div>
                        {currentEntry.selectedSimilarKey === similar.name && (
                          <div className="isw-similar-key-btn__check">✓</div>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="isw-similar-keys__footer">
                    <span className="isw-similar-keys__note">
                      Select an existing key to use instead of creating a new one
                    </span>
                  </div>
                </div>
              )}

              <div className="isw-key-actions">
                {spec.signupUrl && (
                  <button
                    className="isw-action-btn isw-action-btn--primary"
                    onClick={() => {
                      if (window.electronAPI?.system?.invoke) {
                        void window.electronAPI.system.invoke("shell.openExternal", spec.signupUrl);
                      } else {
                        window.open(spec.signupUrl, "_blank");
                      }
                    }}
                  >
                    <ExternalLinkIcon /> Get API Key
                  </button>
                )}
                {alternatives.length > 0 && (
                  <button
                    className="isw-action-btn isw-action-btn--secondary"
                    onClick={() => setShowAlternatives(true)}
                  >
                    <SwapIcon /> I use something else
                  </button>
                )}
              </div>

              <input
                type="password"
                className="isw-key-input"
                placeholder={`Paste your ${spec.service} key here...`}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                autoFocus
              />

              {onRequestHelp && (
                <button
                  className="isw-help-link"
                  onClick={() =>
                    onRequestHelp({
                      service: spec.service,
                      keyName: spec.name,
                      instructions: spec.instructions,
                      signupUrl: spec.signupUrl,
                      docsUrl: spec.docsUrl,
                    })
                  }
                >
                  <HelpCircleIcon /> Need help getting this key?
                </button>
              )}
            </>
          ) : (
            <>
              <div className="isw-key-header">
                <div className="isw-key-icon">
                  <SwapIcon />
                </div>
                <div>
                  <div className="isw-key-title">Use a different service</div>
                  <div className="isw-key-subtitle">
                    The agent will adapt the data pipeline for your service
                  </div>
                </div>
              </div>

              <div className="isw-alternatives">
                <div className="isw-alternatives-label">
                  {known?.category ?? "service"} providers
                </div>

                {alternatives.map((alt) => (
                  <button
                    key={alt.keyName}
                    className={`isw-alt-option ${selectedAlt === alt.service ? "isw-alt-option--selected" : ""}`}
                    onClick={() => {
                      setSelectedAlt(alt.service);
                      setCustomServiceName("");
                    }}
                  >
                    <div
                      className={`isw-alt-radio ${selectedAlt === alt.service ? "isw-alt-radio--checked" : ""}`}
                    />
                    <span className="isw-alt-name">{alt.service}</span>
                    {alt.freeTierNote && (
                      <span className="isw-alt-note">{alt.freeTierNote}</span>
                    )}
                  </button>
                ))}

                <div className="isw-alt-custom-row">
                  <div
                    className={`isw-alt-radio ${selectedAlt === "__custom__" ? "isw-alt-radio--checked" : ""}`}
                    onClick={() => setSelectedAlt("__custom__")}
                  />
                  <input
                    type="text"
                    className="isw-alt-custom-input"
                    placeholder="Other service..."
                    value={customServiceName}
                    onChange={(e) => {
                      setCustomServiceName(e.target.value);
                      setSelectedAlt("__custom__");
                    }}
                    onFocus={() => setSelectedAlt("__custom__")}
                  />
                </div>
              </div>

              {selectedAlt && (
                <div style={{ marginTop: 14 }}>
                  <input
                    type="password"
                    className="isw-key-input"
                    placeholder={`Paste your ${selectedAlt === "__custom__" ? customServiceName || "service" : selectedAlt} key...`}
                    value={altKeyInput}
                    onChange={(e) => setAltKeyInput(e.target.value)}
                    autoFocus
                  />
                </div>
              )}

              <div className="isw-agent-note">
                <span className="isw-agent-note-icon">
                  <SparklesIcon />
                </span>
                <div className="isw-agent-note-text">
                  <strong>The agent will automatically adapt</strong> the data
                  pipeline scripts to work with{" "}
                  {selectedAlt === "__custom__"
                    ? customServiceName || "your service"
                    : selectedAlt ?? "your service"}{" "}
                  instead of {spec.service}. The app UI stays the same — only
                  the data source changes.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="isw-footer">
          <button
            className="isw-btn-secondary"
            onClick={() => {
              if (showAlternatives) {
                setShowAlternatives(false);
                setSelectedAlt(null);
                setAltKeyInput("");
              } else if (currentKeyIdx > 0) {
                setCurrentKeyIdx((prev) => prev - 1);
              } else {
                setStep("overview");
              }
            }}
          >
            Back
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {!currentEntry.spec.required && (
              <button className="isw-btn-secondary" onClick={handleSkipKey}>
                Skip
              </button>
            )}
            <button
              className="isw-btn-primary"
              disabled={!canSubmit}
              onClick={() => void handleKeySubmit()}
            >
              Continue
            </button>
          </div>
        </div>
      </>
    );
  };

  // ── Step 3: Confirm ──

  const renderConfirm = () => (
    <>
      <div className="isw-body">
        <div className="isw-section-label">Setup summary</div>
        {entries.map((entry) => (
          <div key={entry.spec.name} className="isw-integration-row">
            <div className="isw-integration-icon">
              {entry.substitution ? <SwapIcon /> : <KeyIcon />}
            </div>
            <div className="isw-integration-info">
              <div className="isw-integration-name">
                {entry.substitution
                  ? entry.substitution.chosenService
                  : entry.spec.service}
                {entry.substitution && (
                  <span className="isw-sub-label">
                    — replacing {entry.substitution.originalService}
                  </span>
                )}
              </div>
              <div className="isw-integration-desc">
                {entry.substitution
                  ? "Agent will adapt the data pipeline"
                  : entry.status === "connected"
                    ? entry.configuredKeyValue
                      ? "Key saved"
                      : "Already configured"
                    : "Skipped — can add later in Settings"}
              </div>
            </div>
            <span
              className={`isw-badge ${
                entry.substitution
                  ? "isw-badge--substituted"
                  : entry.status === "connected"
                    ? "isw-badge--connected"
                    : "isw-badge--skipped"
              }`}
            >
              {entry.substitution
                ? "Adapted"
                : entry.status === "connected"
                  ? "Ready"
                  : "Skipped"}
            </span>
          </div>
        ))}

        <div className="isw-agent-note">
          <span className="isw-agent-note-icon">
            <BoltIcon />
          </span>
          <div className="isw-agent-note-text">
            <strong>What happens next: </strong>The agent will import the app,
            set up dependencies
            {entries.some((e) => e.substitution)
              ? ", and adapt the data pipelines for your chosen services"
              : ""}
            . This usually takes 1–2 minutes.
          </div>
        </div>
      </div>

      <div className="isw-footer">
        <button
          className="isw-btn-secondary"
          onClick={() => {
            if (missingEntries.length > 0) {
              setCurrentKeyIdx(0);
              setStep("setup");
            } else {
              setStep("overview");
            }
          }}
        >
          Back
        </button>
        <button className="isw-btn-primary" onClick={handleImport}>
          Import App
        </button>
      </div>
    </>
  );

  // ── Main render ────────────────────────────────────────────────────

  const subtitleText =
    step === "overview"
      ? appDescription ?? ""
      : step === "setup" && currentEntry
        ? `Step ${currentKeyIdx + 1} of ${missingEntries.length} — Configure ${currentEntry.spec.service}`
        : "Ready to import";

  return (
    <div className="isw-overlay" onClick={onCancel}>
      <div className="isw-modal" onClick={(e) => e.stopPropagation()}>
        <div className="isw-header">
          <div className="isw-app-info">
            {renderAppIcon()}
            <div>
              <h2 className="isw-app-title">{appName}</h2>
              <p className="isw-app-subtitle">{subtitleText}</p>
            </div>
          </div>
          {stepDots}
        </div>

        {step === "overview" && renderOverview()}
        {step === "setup" && renderSetup()}
        {step === "confirm" && renderConfirm()}
      </div>
    </div>
  );
}
