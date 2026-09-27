/**
 * User-facing experiments (Settings → Privacy → Experiments).
 *
 * An experiment is a randomised A/B on a per-turn basis. When a user opts in,
 * each turn rolls into treatment / control / neither at the registry rates,
 * and the arm is logged on the turn's metrics so cost, latency and quality
 * can be compared within the user's own traffic. Env vars
 * (`PAPR_EXP_<ID>_TREATMENT_RATE` / `_CONTROL_RATE`) still override for dev.
 *
 * Adding an experiment = one entry in EXPERIMENT_REGISTRY + reading the arm
 * where the behaviour forks. The Settings UI renders from this list.
 */

export interface ExperimentDefinition {
  /** Upper-snake id; also the env var infix. */
  id: string;
  label: string;
  description: string;
  /** Rates used when the user has this experiment enabled. */
  treatmentRate: number;
  controlRate: number;
}

export const EXPERIMENT_REGISTRY: readonly ExperimentDefinition[] = [
  {
    id: "JEV_CATALOG",
    label: "Smarter memory catalog (Jev)",
    description:
      "Filters the memory catalog injected on your second message using TypeSafe Jev, keeping only memories likely to help. Half of eligible turns use the filter, half keep the current behaviour, so we can compare cost and answer quality.",
    treatmentRate: 0.5,
    controlRate: 0.5,
  },
  {
    id: "JEV_TOOL_TRIM",
    label: "Smarter tool-result trimming (Jev)",
    description:
      "When an older shell result is shortened to save context, keep the parts TypeSafe Jev rates relevant to what you asked instead of the first and last lines. Half of turns use it, half keep the current behaviour, so we can compare how often the agent has to fetch the full result again.",
    treatmentRate: 0.5,
    controlRate: 0.5,
  },
];

/**
 * Bump when the defaults change in a way that should re-apply to existing
 * installs (e.g. turning experiments on for everyone). Saved settings with an
 * older version are treated as unset; opt-outs made after the bump are stored
 * with the current version and stay honoured.
 */
export const EXPERIMENT_SETTINGS_VERSION = 2;

export interface ExperimentSettings {
  /** Master opt-in. When false, no experiment assigns an arm. */
  enabled: boolean;
  /** Per-experiment opt-in, keyed by id. Missing = off. */
  flags: Record<string, boolean>;
  /** Defaults version these values were saved against. */
  version?: number;
}

/**
 * Experiments are ON by default for everyone. With all users enrolled, the
 * per-turn treatment/control split (see EXPERIMENT_REGISTRY rates) is what
 * makes the comparison valid. Turning the master switch or one flag off
 * gives the old behaviour and no arm tag. `mergeExperimentSettings` layers
 * saved values over these, so an explicit opt-out persists across upgrades.
 */
export const DEFAULT_EXPERIMENT_SETTINGS: ExperimentSettings = {
  enabled: true,
  flags: Object.fromEntries(EXPERIMENT_REGISTRY.map((e) => [e.id, true])),
  version: EXPERIMENT_SETTINGS_VERSION,
};

export function mergeExperimentSettings(
  saved: Partial<ExperimentSettings> | undefined,
): ExperimentSettings {
  // Saved values from an older defaults version are stale — a persisted
  // `enabled: false` from a build where that was the default is not an
  // opt-out. Re-apply current defaults; the next save stamps the new version.
  const current = (saved?.version ?? 0) >= EXPERIMENT_SETTINGS_VERSION ? saved : undefined;
  return {
    enabled: current?.enabled ?? DEFAULT_EXPERIMENT_SETTINGS.enabled,
    flags: { ...DEFAULT_EXPERIMENT_SETTINGS.flags, ...(current?.flags ?? {}) },
    version: EXPERIMENT_SETTINGS_VERSION,
  };
}

export function isExperimentEnabled(
  settings: ExperimentSettings,
  id: string,
): boolean {
  return settings.enabled && settings.flags[id] === true;
}

/** Rates the arm decider should use for this experiment given user settings. */
export function resolveExperimentRates(
  settings: ExperimentSettings,
  id: string,
): { treatmentRate: number; controlRate: number } {
  const def = EXPERIMENT_REGISTRY.find((e) => e.id === id);
  if (!def || !isExperimentEnabled(settings, id)) {
    return { treatmentRate: 0, controlRate: 0 };
  }
  return { treatmentRate: def.treatmentRate, controlRate: def.controlRate };
}
