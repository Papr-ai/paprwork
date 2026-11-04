/**
 * FocusView — the agent's page, opened from the rail agent. One job: what matters today.
 * The Home brief is the page. Needs you (top, the "Do this first" slot) and Waiting on (under Your three)
 * render inside it with the brief's own styles; useFocusBridge feeds them and runs their actions.
 * Without a Home app, the native list shows instead so nothing waiting on you is ever hidden.
 */
import { useEffect, useRef, useState } from "react";
import { HomeTodayView } from "../Memory/HomeTodayView";
import { useDefaultHomeApp } from "../../hooks/useDefaultHomeApp";
import { NeedsYou } from "./NeedsYou";
import { WaitingOn } from "./MentionFocus";
import { useFocusBridge } from "./focusBridge";
import "../Memory/WikiLibrary.css";

export function FocusView() {
  const [refreshToken, setRefreshToken] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const { appId, loading } = useDefaultHomeApp();
  useFocusBridge(root);

  useEffect(() => {
    const onSwitched = () => setRefreshToken((t) => t + 1);
    window.addEventListener("papr-workspace-switch-complete", onSwitched);
    return () => window.removeEventListener("papr-workspace-switch-complete", onSwitched);
  }, []);

  return (
    <div className="memory-view focus-view" data-testid="focus-view" ref={root}>
      {!loading && !appId ? <><NeedsYou /><WaitingOn /></> : null}
      <HomeTodayView refreshToken={refreshToken} />
    </div>
  );
}
