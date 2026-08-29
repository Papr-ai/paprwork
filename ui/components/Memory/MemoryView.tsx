/**
 * MemoryView — Home workspace with Today, Tasks, and Memory tabs
 */

import React, {
  useCallback,
  useEffect,
  useState,
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { MemoryIcon } from "./MemoryIcon";
import { WikiLibrary, type HomeWorkspaceTab } from "./WikiLibrary";
import "./WikiLibrary.css";

const WORKSPACE_TAB_KEY = "home-workspace-tab";

class MemoryErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[MemoryView] Render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="wiki-empty-state">
          <h2>Home page error</h2>
          <p>
            {this.state.error.message ||
              "Something went wrong while loading this view."}
          </p>
          <button
            type="button"
            className="wiki-btn wiki-btn--secondary"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const WORKSPACE_TABS: { id: HomeWorkspaceTab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
];

function readStoredWorkspaceTab(): HomeWorkspaceTab {
  try {
    const stored = sessionStorage.getItem(WORKSPACE_TAB_KEY);
    if (stored === "home") return "today";
    if (stored === "today" || stored === "tasks" || stored === "memory") {
      return stored;
    }
  } catch {
    /* noop */
  }
  return "today";
}

export function MemoryView() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [boundaryKey, setBoundaryKey] = useState(0);
  const [workspaceTab, setWorkspaceTab] = useState<HomeWorkspaceTab>(
    readStoredWorkspaceTab,
  );
  /** Label of the currently focused entity (null = home/library) */
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  /** Callback to clear focus (go back to library) */
  const [onBack, setOnBack] = useState<(() => void) | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(WORKSPACE_TAB_KEY, workspaceTab);
    } catch {
      /* noop */
    }
  }, [workspaceTab]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onSwitchStart = () => {
      setFocusLabel(null);
      setOnBack(null);
      try {
        sessionStorage.removeItem("memory-view-focus");
      } catch {
        /* noop */
      }
    };
    const onSwitchComplete = () => {
      setRefreshToken((t) => t + 1);
    };
    window.addEventListener("papr-workspace-switch-start", onSwitchStart);
    window.addEventListener("papr-workspace-switch-complete", onSwitchComplete);
    return () => {
      window.removeEventListener("papr-workspace-switch-start", onSwitchStart);
      window.removeEventListener(
        "papr-workspace-switch-complete",
        onSwitchComplete,
      );
    };
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  /** WikiLibrary reports its focus changes here */
  const handleFocusChange = useCallback(
    (label: string | null, backFn: (() => void) | null) => {
      setFocusLabel(label);
      setOnBack(() => backFn);
    },
    [],
  );

  const handleBackClick = useCallback(() => {
    if (onBack) onBack();
  }, [onBack]);

  const activeTabLabel =
    WORKSPACE_TABS.find((tab) => tab.id === workspaceTab)?.label ?? "Today";

  return (
    <div className="memory-view">
      <header className="wiki-topbar">
        <button
          type="button"
          className={`wiki-topbar__brand${focusLabel ? " wiki-topbar__brand--clickable" : ""}`}
          onClick={focusLabel ? handleBackClick : undefined}
          aria-label={focusLabel ? "Back to Home" : "Home"}
        >
          <span className="wiki-topbar__logo" aria-hidden>
            <MemoryIcon size={14} />
          </span>
          <span>Home</span>
        </button>
        <span className="wiki-topbar__sep">/</span>
        <div className="wiki-topbar__crumbs">
          {focusLabel ? (
            <>
              <button
                type="button"
                className="wiki-topbar__crumb-link"
                onClick={handleBackClick}
              >
                {activeTabLabel}
              </button>
              <span className="wiki-topbar__sep">/</span>
              <span className="wiki-topbar__cur">{focusLabel}</span>
            </>
          ) : (
            <nav className="home-workspace-nav" aria-label="Home sections">
              {WORKSPACE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`home-workspace-nav__tab${workspaceTab === tab.id ? " home-workspace-nav__tab--active" : ""}`}
                  aria-current={workspaceTab === tab.id ? "page" : undefined}
                  onClick={() => setWorkspaceTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="wiki-topbar__grow" />
        <button
          type="button"
          className="wiki-topbar__search"
          onClick={() => setPaletteOpen(true)}
        >
          Search… <span className="wiki-topbar__kbd">⌘K</span>
        </button>
        <button
          type="button"
          className="wiki-topbar__refresh"
          onClick={handleRefresh}
          aria-label="Refresh"
        >
          ↻
        </button>
      </header>

      <div className="memory-view__body">
        <MemoryErrorBoundary
          key={boundaryKey}
          onReset={() => {
            try {
              sessionStorage.removeItem("memory-view-focus");
            } catch {
              /* noop */
            }
            setFocusLabel(null);
            setOnBack(null);
            setRefreshToken((t) => t + 1);
            setBoundaryKey((k) => k + 1);
          }}
        >
          <WikiLibrary
            refreshToken={refreshToken}
            paletteOpen={paletteOpen}
            onPaletteOpenChange={setPaletteOpen}
            onFocusChange={handleFocusChange}
            workspaceTab={workspaceTab}
          />
        </MemoryErrorBoundary>
      </div>
    </div>
  );
}
