import { MiniAppView } from "../Apps/MiniAppView";
import { useDefaultHomeApp } from "../../hooks/useDefaultHomeApp";
import "./HomeTodayView.css";

export function HomeTodayView() {
  const { appId, loading } = useDefaultHomeApp();

  if (loading) {
    return (
      <div className="home-today home-today--loading">
        <p>Loading today&apos;s brief…</p>
      </div>
    );
  }

  if (!appId) {
    return (
      <div className="home-today home-today--empty">
        <h2>Home dashboard not found</h2>
        <p>
          The daily brief app is missing from this workspace. Open Apps to
          reinstall it, or ask the agent to restore the home dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="home-today">
      <MiniAppView appId={appId} embedded previewTabVisible />
    </div>
  );
}
