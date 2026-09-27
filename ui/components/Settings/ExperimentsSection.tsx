/**
 * ExperimentRows — Settings → Privacy → experiments block.
 *
 * Master switch plus one row per entry in EXPERIMENT_REGISTRY. Each
 * experiment randomises per turn and records its arm on the turn's metrics,
 * so a toggle here enrols the user in an A/B rather than flipping behaviour
 * deterministically. Rendered inside PrivacyTab's card, not as its own card.
 */

import { useCallback, useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import {
  DEFAULT_EXPERIMENT_SETTINGS,
  EXPERIMENT_REGISTRY,
  mergeExperimentSettings,
  type ExperimentSettings,
} from "../../../src/core/types/experimentSettings";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";

export function ExperimentRows() {
  const [settings, setSettings] = useState<ExperimentSettings>(DEFAULT_EXPERIMENT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await gateway.send("settings:get");
      const data = response.data as { experiments?: Partial<ExperimentSettings> };
      setSettings(mergeExperimentSettings(data.experiments));
    } catch (err) {
      console.error("[ExperimentRows] load failed:", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: ExperimentSettings) => {
    setSettings(next);
    setSaving(true);
    try {
      const response = await gateway.send("settings:save-experiments", next);
      setSettings(mergeExperimentSettings(response.data as Partial<ExperimentSettings>));
    } catch (err) {
      console.error("[ExperimentRows] save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <>
      <SettingRow
        label="Experiments"
        hint="Try improvements before they ship. Each one A/B tests on your turns; results stay on this device unless usage data is on."
      >
        <Toggle
          checked={settings.enabled}
          disabled={saving}
          onChange={(v) => void persist({ ...settings, enabled: v })}
          ariaLabel="Enable experiments"
        />
      </SettingRow>
      {EXPERIMENT_REGISTRY.map((exp) => (
        <SettingRow key={exp.id} nested disabled={!settings.enabled} label={exp.label} hint={exp.description}>
          <Toggle
            checked={settings.enabled && settings.flags[exp.id] === true}
            disabled={saving || !settings.enabled}
            onChange={(v) => void persist({ ...settings, flags: { ...settings.flags, [exp.id]: v } })}
            ariaLabel={exp.label}
          />
        </SettingRow>
      ))}
    </>
  );
}
