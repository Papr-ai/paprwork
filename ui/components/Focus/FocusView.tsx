/**
 * FocusView — the agent's page, opened from the rail agent. One job: what matters today.
 * Native: the brief, Needs you, Your three, Waiting on, goals and tasks (Focus/page). No iframe.
 */
import { FocusPage } from "./page/FocusPage";

export function FocusView() {
  return (
    <div className="focus-view" data-testid="focus-view">
      <FocusPage />
    </div>
  );
}
