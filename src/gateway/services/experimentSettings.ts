/**
 * Gateway-side cache of experiment settings (mirrors toolResultTruncationSettings).
 * Refreshed on boot, workspace switch, and every save from Settings.
 */

import {
  DEFAULT_EXPERIMENT_SETTINGS,
  mergeExperimentSettings,
  resolveExperimentRates,
  type ExperimentSettings,
} from "../../core/types/experimentSettings.js";
import { loadSettings } from "./settingsStore.js";

let cached: ExperimentSettings = { ...DEFAULT_EXPERIMENT_SETTINGS };

export function getExperimentSettings(): ExperimentSettings {
  return cached;
}

export function setExperimentSettings(next: ExperimentSettings): ExperimentSettings {
  cached = mergeExperimentSettings(next);
  return cached;
}

export async function refreshExperimentSettings(): Promise<ExperimentSettings> {
  const settings = await loadSettings();
  cached = mergeExperimentSettings(settings.experiments);
  return cached;
}

/** Rates for `decideExperimentArm` defaults, from the user's opt-in state. */
export function experimentRatesFor(id: string): {
  treatmentRate: number;
  controlRate: number;
} {
  return resolveExperimentRates(cached, id);
}
