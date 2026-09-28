/**
 * FocusView — the agent's page, opened from the rail agent. One job: what matters today.
 * No in-page chrome: the Home mini-app owns Today | All tasks, the rail owns Memory and Search.
 */
import { useEffect, useState } from "react";
import { HomeTodayView } from "../Memory/HomeTodayView";
import "../Memory/WikiLibrary.css";

export function FocusView() {
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const onSwitched = () => setRefreshToken((t) => t + 1);
    window.addEventListener("papr-workspace-switch-complete", onSwitched);
    return () => window.removeEventListener("papr-workspace-switch-complete", onSwitched);
  }, []);

  return (
    <div className="memory-view focus-view" data-testid="focus-view">
      <HomeTodayView refreshToken={refreshToken} />
    </div>
  );
}
