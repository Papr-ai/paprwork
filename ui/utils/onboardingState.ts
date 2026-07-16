/**
 * Onboarding State Machine
 * 
 * Replaces scattered localStorage flags with a single versioned state object.
 * 
 * Flow:
 *   welcome → connect_model → choose_intent → first_value → activated → completed
 * 
 * - welcome:       User sees the onboarding view for the first time
 * - connect_model:  User needs to connect ChatGPT/Claude (prerequisite for good experience)
 * - choose_intent:  User picks what they want to do (finish work, build tool, automate, personalize)
 * - first_value:    User's first real task is in progress (chat sent, waiting for result)
 * - activated:      A durable result was created (app, document, job, etc.)
 * - completed:      Onboarding dismissed
 */

export type OnboardingPhase =
  | "welcome"
  | "connect_model"
  | "choose_intent"
  | "first_value"
  | "activated"
  | "completed";

export type OnboardingIntent =
  | "finish_work"
  | "build_tool"
  | "automate"
  | "personalize"
  | "explore"
  | null;

export interface OnboardingState {
  version: 2;
  phase: OnboardingPhase;
  intent: OnboardingIntent;
  modelConnected: boolean;
  firstChatSent: boolean;
  firstResultCreated: boolean;
  dismissedAt: string | null;
}

const STORAGE_KEY = "papr-onboarding-state";

const DEFAULT_STATE: OnboardingState = {
  version: 2,
  phase: "welcome",
  intent: null,
  modelConnected: false,
  firstChatSent: false,
  firstResultCreated: false,
  dismissedAt: null,
};

/** Read the current onboarding state (migrates v1 flags if needed). */
export function getOnboardingState(): OnboardingState {
  // Try v2 state first
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as OnboardingState;
      if (parsed.version === 2) return parsed;
    } catch { /* fall through to migration */ }
  }

  // Migrate from v1 localStorage flags
  const dismissed = localStorage.getItem("papr-onboarding-dismissed") === "true";
  const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
  const step2 = localStorage.getItem("papr-onboarding-step2") === "true";

  if (dismissed || (step1 && step2)) {
    // User already completed v1 onboarding — mark as completed
    const migrated: OnboardingState = {
      ...DEFAULT_STATE,
      phase: "completed",
      modelConnected: true,
      firstChatSent: true,
      firstResultCreated: true,
      dismissedAt: new Date().toISOString(),
    };
    saveOnboardingState(migrated);
    return migrated;
  }

  if (step1) {
    // User started v1 but didn't finish — put them at choose_intent
    const migrated: OnboardingState = {
      ...DEFAULT_STATE,
      phase: "choose_intent",
      modelConnected: true,
      firstChatSent: true,
    };
    saveOnboardingState(migrated);
    return migrated;
  }

  return DEFAULT_STATE;
}

/** Save onboarding state and notify listeners. */
export function saveOnboardingState(state: OnboardingState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // Keep v1 flags in sync for any code that still reads them
  localStorage.setItem("papr-onboarding-step1", String(state.firstChatSent));
  localStorage.setItem("papr-onboarding-step2", String(state.firstResultCreated));
  if (state.phase === "completed") {
    localStorage.setItem("papr-onboarding-dismissed", "true");
  }
  window.dispatchEvent(new CustomEvent("papr-onboarding-changed"));
}

/** Transition to a new phase. Returns the updated state. */
export function transitionTo(
  phase: OnboardingPhase,
  patch?: Partial<OnboardingState>,
): OnboardingState {
  const current = getOnboardingState();
  const next: OnboardingState = {
    ...current,
    ...patch,
    phase,
  };
  if (phase === "completed" && !next.dismissedAt) {
    next.dismissedAt = new Date().toISOString();
  }
  saveOnboardingState(next);
  return next;
}

/** Check if onboarding should be shown. */
export function shouldShowOnboarding(): boolean {
  const state = getOnboardingState();
  return state.phase !== "completed";
}

/** Check if the user has connected at least one AI model. */
export function isModelConnected(): boolean {
  return getOnboardingState().modelConnected;
}

/** Mark a model as connected and advance phase if needed. */
export function markModelConnected(): OnboardingState {
  const current = getOnboardingState();
  if (current.phase === "connect_model") {
    return transitionTo("choose_intent", { modelConnected: true });
  }
  current.modelConnected = true;
  saveOnboardingState(current);
  return current;
}

/** Set the user's chosen intent and advance to first_value. */
export function setIntent(intent: OnboardingIntent): OnboardingState {
  return transitionTo("first_value", { intent });
}

/** Mark that the first chat was sent (user started real work). */
export function markFirstChatSent(): OnboardingState {
  const current = getOnboardingState();
  current.firstChatSent = true;
  saveOnboardingState(current);
  return current;
}

/** Mark first durable result created — this is true activation. */
export function markFirstResultCreated(): OnboardingState {
  return transitionTo("activated", { firstResultCreated: true });
}

/** Dismiss onboarding (user can always skip). */
export function dismissOnboarding(): OnboardingState {
  return transitionTo("completed");
}
