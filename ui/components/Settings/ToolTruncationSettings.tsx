/**
 * ToolTruncationSettings — Agent context / tool result truncation controls
 */

import React, { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type { ToolResultTruncationSettings } from "../../../src/core/types/toolResultTruncationSettings";
import { DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS } from "../../../src/core/types/toolResultTruncationSettings";

export function ToolTruncationSettings() {
  const [settings, setSettings] = useState<ToolResultTruncationSettings>({
    ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await gateway.send("settings:get");
      const data = response.data as {
        toolResultTruncation?: Partial<ToolResultTruncationSettings>;
      };
      setSettings({
        ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
        ...data.toolResultTruncation,
      });
    } catch (err) {
      console.error("[ToolTruncationSettings] load failed:", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: ToolResultTruncationSettings) => {
    setSaving(true);
    setSavedFlash(false);
    try {
      const response = await gateway.send("settings:save-tool-truncation", next);
      const data = response.data as ToolResultTruncationSettings;
      setSettings({ ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS, ...data });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      console.error("[ToolTruncationSettings] save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<ToolResultTruncationSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  };

  const handleSave = () => {
    void persist(settings);
  };

  const handleDisableAll = (disabled: boolean) => {
    const next = { ...settings, disableAllTruncation: disabled };
    setSettings(next);
    void persist(next);
  };

  const handleResetDefaults = () => {
    const next = { ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS };
    setSettings(next);
    void persist(next);
  };

  if (!loaded) {
    return (
      <div className="settings-section">
        <p className="settings-section__description">Loading agent context settings…</p>
      </div>
    );
  }

  const advancedDisabled = settings.disableAllTruncation;

  return (
    <div className="settings-section tool-truncation-settings">
      <h2 className="settings-section__title">Agent Context</h2>
      <p className="settings-section__description">
        Control how much of each tool result the agent keeps in its working memory.
        Lower limits save context window space but can cause the agent to re-fetch data.
        Changes apply to new messages immediately.
      </p>

      <div className="tool-truncation-settings__hero">
        <label className="permission-option">
          <input
            type="checkbox"
            checked={settings.disableAllTruncation}
            disabled={saving}
            onChange={(e) => void handleDisableAll(e.target.checked)}
          />
          <div className="permission-card">
            <div className="permission-header">
              <h4>Disable all truncation (experimental)</h4>
            </div>
            <p>
              Keep full tool results when loading prior turns into context (cross-turn).
              Mid-turn compaction can still be toggled separately below. May hit context
              limits on long sessions; conversation compression still applies.
            </p>
          </div>
        </label>
      </div>

      <div
        className={`tool-truncation-settings__advanced${advancedDisabled ? " tool-truncation-settings__advanced--disabled" : ""}`}
      >
        <h3 className="tool-truncation-settings__subtitle">Custom limits</h3>
        <p className="settings-section__description">
          Cross-turn category limits (when truncation is enabled). Mid-turn compaction
          also uses the moderate limit for stale bash/browser batches.
        </p>

        <div className="tool-truncation-settings__grid">
          <div className="form-group">
            <label className="form-label" htmlFor="trunc-aggressive">
              Bash / browser / jobs (chars)
            </label>
            <input
              id="trunc-aggressive"
              type="number"
              className="form-input"
              min={0}
              max={500_000}
              step={100}
              disabled={advancedDisabled || saving}
              value={settings.aggressiveMaxChars}
              onChange={(e) =>
                update({ aggressiveMaxChars: Number(e.target.value) || 0 })
              }
            />
            <span className="form-hint">Default: 400</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="trunc-moderate">
              Code summaries / plans (chars)
            </label>
            <input
              id="trunc-moderate"
              type="number"
              className="form-input"
              min={0}
              max={500_000}
              step={100}
              disabled={advancedDisabled || saving}
              value={settings.moderateMaxChars}
              onChange={(e) =>
                update({ moderateMaxChars: Number(e.target.value) || 0 })
              }
            />
            <span className="form-hint">Default: 2,000</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="trunc-memory">
              Memory / graph search (chars)
            </label>
            <input
              id="trunc-memory"
              type="number"
              className="form-input"
              min={0}
              max={500_000}
              step={100}
              disabled={advancedDisabled || saving}
              value={settings.memorySearchMaxChars}
              onChange={(e) =>
                update({ memorySearchMaxChars: Number(e.target.value) || 0 })
              }
            />
            <span className="form-hint">Default: 800</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="trunc-retention">
              Recent-turn full retention (user turns)
            </label>
            <input
              id="trunc-retention"
              type="number"
              className="form-input"
              min={0}
              max={50}
              step={1}
              disabled={advancedDisabled || saving}
              value={settings.recentTurnRetentionCount}
              onChange={(e) =>
                update({
                  recentTurnRetentionCount: Number(e.target.value) || 0,
                })
              }
            />
            <span className="form-hint">
              Bash &amp; discovery lists stay full for this many turns after fetch
            </span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="trunc-absolute">
              Absolute cap per result (chars)
            </label>
            <input
              id="trunc-absolute"
              type="number"
              className="form-input"
              min={0}
              max={2_000_000}
              step={1000}
              disabled={advancedDisabled || saving}
              value={settings.absoluteMaxChars ?? 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                update({
                  absoluteMaxChars: n <= 0 ? null : n,
                });
              }}
            />
            <span className="form-hint">Default: 40,000. Set 0 for no cap.</span>
          </div>
        </div>

      </div>

      <div className="tool-truncation-settings__hero" style={{ marginTop: "1rem" }}>
        <label className="permission-option">
          <input
            type="checkbox"
            checked={settings.midTurnCompactionEnabled}
            disabled={saving}
            onChange={(e) => {
              const next = {
                ...settings,
                midTurnCompactionEnabled: e.target.checked,
              };
              setSettings(next);
              void persist(next);
            }}
          />
          <div className="permission-card">
            <div className="permission-header">
              <h4>Mid-turn compaction</h4>
            </div>
            <p>
              Truncate older tool batches within the same assistant response (multi-step
              tool loops). Independent of cross-turn truncation — you can disable
              cross-turn limits above and still compact stale batches inside one long turn.
            </p>
          </div>
        </label>
      </div>

      <div className="settings-actions">
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          disabled={advancedDisabled || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save limits"}
        </button>
        <button
          type="button"
          className="settings-btn"
          disabled={saving}
          onClick={handleResetDefaults}
        >
          Reset to defaults
        </button>
        {savedFlash && (
          <span className="tool-truncation-settings__saved">Saved</span>
        )}
      </div>
    </div>
  );
}
