/**
 * Local persistence for the commercial pre-app AuthFlow gate.
 *
 * Papr login (keychain) and "finished connect + recommend" are separate: a user
 * can be signed in but still owe connect/recommend steps. App.tsx must not
 * treat checkLoginStatus() alone as permission to enter the workspace.
 */

import type { OnboardingStepId } from "./onboardingRemote";

export type AuthFlowStage = "signin" | "org" | "connect" | "recommend";

const STORAGE_KEY = "papr-auth-flow-v1";

export interface AuthFlowPersisted {
  step: OnboardingStepId;
  updatedAt: string;
}

const STAGE_ORDER: readonly AuthFlowStage[] = [
  "signin",
  "org",
  "connect",
  "recommend",
];

function readRaw(): AuthFlowPersisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthFlowPersisted;
    if (!parsed?.step) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(step: OnboardingStepId): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ step, updatedAt: new Date().toISOString() } satisfies AuthFlowPersisted),
    );
  } catch {
    // Non-fatal — server breadcrumb may still exist.
  }
}

export function persistAuthFlowStage(stage: AuthFlowStage): void {
  write(stage as OnboardingStepId);
}

export function markAuthFlowCompleteLocal(): void {
  write("done");
}

export function clearAuthFlowPersistence(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isAuthFlowCompleteLocal(): boolean {
  return readRaw()?.step === "done";
}

export function getLocalAuthFlowStep(): OnboardingStepId | undefined {
  const step = readRaw()?.step;
  return step && step !== "done" ? step : undefined;
}

function stageIndex(stage: AuthFlowStage | OnboardingStepId): number {
  if (stage === "done") return STAGE_ORDER.length;
  const idx = STAGE_ORDER.indexOf(stage as AuthFlowStage);
  return idx >= 0 ? idx : 0;
}

/** Pick the furthest stage reached (monotonic — never rewind on merge). */
export function mergeAuthFlowStage(
  local: AuthFlowStage | OnboardingStepId | undefined,
  remote: OnboardingStepId | string | undefined,
): AuthFlowStage {
  const a = local ? stageIndex(local) : -1;
  const b = remote ? stageIndex(remote as OnboardingStepId) : -1;
  const idx = Math.max(a, b);
  if (idx >= STAGE_ORDER.length) return "recommend";
  return STAGE_ORDER[idx] ?? "connect";
}

/**
 * Stage to open when Papr is already logged in but the gate is incomplete.
 * Never returns signin — that screen is for missing Papr session.
 */
export function resumeStageWhenLoggedIn(
  local: AuthFlowStage | OnboardingStepId | undefined,
  remote: OnboardingStepId | string | undefined,
): AuthFlowStage {
  const merged = mergeAuthFlowStage(local, remote);
  if (merged === "signin") return "connect";
  return merged;
}
