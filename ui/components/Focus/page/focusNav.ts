/**
 * Open one goal on the Focus page from anywhere (rail peek, nudges). The page may not be mounted yet,
 * so the request is parked until it takes it. Replaces the old postMessage into the Home iframe.
 */
export const FOCUS_OPEN_GOAL_EVENT = "papr-focus-open-goal";

let pending: string | null = null;

export function openFocusGoal(goalId: string): void {
  pending = goalId;
  window.dispatchEvent(new CustomEvent(FOCUS_OPEN_GOAL_EVENT));
}

export function takePendingFocusGoal(): string | null {
  const id = pending;
  pending = null;
  return id;
}
