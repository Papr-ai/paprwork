import { useEffect, useState } from "react";
import { MiniAppView } from "../Apps/MiniAppView";
import { useDefaultHomeApp } from "../../hooks/useDefaultHomeApp";
import { DEFAULT_HOME_DAILY_BRIEF_JOB_NAME } from "../../constants/defaultHomeApp";
import "./HomeTodayView.css";

const DAILY_BRIEF_JOB_TERMINAL = new Set(["completed", "failed", "idle"]);

interface HomeTodayViewProps {
  refreshToken?: number;
}

export function HomeTodayView({ refreshToken = 0 }: HomeTodayViewProps) {
  const { appId, loading } = useDefaultHomeApp();
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => {
    setIframeKey((key) => key + 1);
  }, [refreshToken, appId]);

  useEffect(() => {
    if (!appId) return;

    const reloadBrief = (): void => {
      setIframeKey((key) => key + 1);
    };

    const handler = (event: Event): void => {
      const detail = (event as CustomEvent).detail as {
        type?: string;
        data?: {
          name?: string;
          status?: string;
          tables?: string[];
        };
      };
      if (!detail?.type) return;

      if (
        detail.type === "jobs:status-changed" &&
        detail.data?.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME &&
        detail.data.status &&
        DAILY_BRIEF_JOB_TERMINAL.has(detail.data.status)
      ) {
        reloadBrief();
        return;
      }

      if (
        detail.type === "jobs:db-changed" &&
        detail.data?.tables?.includes("briefs")
      ) {
        reloadBrief();
      }
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [appId]);

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
      <MiniAppView
        key={iframeKey}
        appId={appId}
        embedded
        previewTabVisible
      />
    </div>
  );
}
