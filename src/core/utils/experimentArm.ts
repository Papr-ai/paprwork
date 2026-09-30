/**
 * Generic randomised-exposure arm assignment for turn-level experiments.
 *
 * Same discipline as `retrievalProbe.ts`: the roll is independent of
 * everything about the turn, so within the tagged slice the treatment is
 * exogenous and `treatment` vs `control` rows are a valid comparison. Untagged
 * turns (the common case) are NOT the control group.
 *
 * Rates are read from env as `PAPR_EXP_<NAME>_TREATMENT_RATE` and
 * `PAPR_EXP_<NAME>_CONTROL_RATE` (0..1). Missing or malformed values fall back
 * to the defaults passed by the caller, so an experiment can ship dark
 * (defaults 0/0) and be switched on per machine without a release.
 */

export type ExperimentArm = "treatment" | "control";

export interface ExperimentArmInput {
  /** Short upper-snake name, e.g. "JEV_CATALOG". Used in env var names. */
  name: string;
  defaultTreatmentRate: number;
  defaultControlRate: number;
  /** Injected for tests. Defaults to Math.random. */
  random?: () => number;
  env?: NodeJS.ProcessEnv;
}

function readRate(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export function experimentEnvKeys(name: string): {
  treatment: string;
  control: string;
} {
  const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    treatment: `PAPR_EXP_${key}_TREATMENT_RATE`,
    control: `PAPR_EXP_${key}_CONTROL_RATE`,
  };
}

/** Returns null when this turn is not part of the experiment. */
export function decideExperimentArm(
  input: ExperimentArmInput,
): ExperimentArm | null {
  const env = input.env ?? process.env;
  const keys = experimentEnvKeys(input.name);
  const treatmentRate = readRate(env[keys.treatment], input.defaultTreatmentRate);
  const controlRate = readRate(env[keys.control], input.defaultControlRate);
  if (treatmentRate <= 0 && controlRate <= 0) return null;

  const roll = (input.random ?? Math.random)();
  if (roll < treatmentRate) return "treatment";
  if (roll < treatmentRate + controlRate) return "control";
  return null;
}
