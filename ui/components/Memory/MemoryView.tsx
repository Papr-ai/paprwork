/**
 * MemoryView — what the agent knows: people, projects, context. Its own rail destination.
 * No in-page chrome: entity pages carry their own back, and rail Search / ⌘K is scoped here.
 */

import { useEffect, useState, Component, type ErrorInfo, type ReactNode } from "react";
import { WikiLibrary } from "./WikiLibrary";
import "./WikiLibrary.css";

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
          <h2>Memory couldn&apos;t load</h2>
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

function clearCachedFocus(): void {
  try {
    sessionStorage.removeItem("memory-view-focus");
  } catch {
    /* noop */
  }
}

export function MemoryView() {
  const [refreshToken, setRefreshToken] = useState(0);
  const [boundaryKey, setBoundaryKey] = useState(0);

  useEffect(() => {
    const onSwitchStart = () => clearCachedFocus();
    const onSwitchComplete = () => setRefreshToken((t) => t + 1);
    window.addEventListener("papr-workspace-switch-start", onSwitchStart);
    window.addEventListener("papr-workspace-switch-complete", onSwitchComplete);
    return () => {
      window.removeEventListener("papr-workspace-switch-start", onSwitchStart);
      window.removeEventListener("papr-workspace-switch-complete", onSwitchComplete);
    };
  }, []);

  return (
    <div className="memory-view" data-testid="memory-view">
      <div className="memory-view__body">
        <MemoryErrorBoundary
          key={boundaryKey}
          onReset={() => {
            clearCachedFocus();
            setRefreshToken((t) => t + 1);
            setBoundaryKey((k) => k + 1);
          }}
        >
          <WikiLibrary refreshToken={refreshToken} />
        </MemoryErrorBoundary>
      </div>
    </div>
  );
}
