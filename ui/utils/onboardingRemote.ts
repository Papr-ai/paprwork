/**
 * Renderer-side accessor for server-persisted onboarding progress.
 *
 * localStorage remains the fast path (synchronous, works offline); Parse is the
 * durable one. This module is the only place the renderer talks to the server
 * columns, so the merge rule lives in exactly one spot.
 *
 * MERGE RULE: the server can only ever ADVANCE local state, never rewind it.
 * A user who finished on another machine should skip the gate here — but a user
 * who just finished locally must not be sent back through it because a write
 * failed or the read raced. Completion is monotonic.
 *
 * Every call is soft: a network failure means the user sees the gate they would
 * have seen before this file existed. It must never trap or block them.
 */

/** Stage identifiers stored in PaprWorkOnboardingStep — for resume + funnel drop-off. */
export type OnboardingStepId =
  | "signin"
  | "org"
  | "connect"
  | "recommend"
  | "done";

export interface RemoteOnboarding {
  completed: boolean;
  completedAt?: string;
  step?: string;
}

/** Read server state. Undefined = signed out, offline, or unreadable. */
export async function fetchRemoteOnboarding(): Promise<
  RemoteOnboarding | undefined
> {
  try {
    const result = await window.electronAPI?.papr?.getOnboardingState?.();
    return result?.success ? result.state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record which stage the user reached. Fire-and-forget: progress tracking must
 * never add latency to a stage transition.
 */
export function recordOnboardingStep(step: OnboardingStepId): void {
  void window.electronAPI?.papr?.setOnboardingState?.({ step }).catch(() => {
    // Soft by design — local state still advances the user.
  });
}

/**
 * Mark onboarding finished. Awaited by callers that want the write to land
 * before the gate releases, but still safe to ignore.
 */
export async function recordOnboardingComplete(): Promise<void> {
  try {
    await window.electronAPI?.papr?.setOnboardingState?.({
      step: "done",
      completed: true,
    });
  } catch {
    // Soft by design.
  }
}
