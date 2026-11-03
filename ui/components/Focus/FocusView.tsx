/**
 * FocusView — the agent's page, opened from the rail agent. One job: what matters today.
 * Needs you sits on top (everything waiting on you); below it the Home mini-app owns the Daily Brief.
 */
import { useEffect, useState } from "react";
import { HomeTodayView } from "../Memory/HomeTodayView";
import { NeedsYou } from "./NeedsYou";
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
      <NeedsYou />
      <HomeTodayView refreshToken={refreshToken} />
    </div>
  );
}
