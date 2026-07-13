/**
 * MemoryView — Wiki library + context files in a unified Meridian-style shell
 * 
 * v2: Removed wiki/context tab toggle (context is now inline in wiki home).
 *     Added breadcrumb navigation and sessionStorage position caching.
 */

import React, { useCallback, useEffect, useState, Component, type ErrorInfo, type ReactNode } from "react";
import { MemoryIcon } from "./MemoryIcon";
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
          <h2>Memory page error</h2>
          <p>{this.state.error.message || "Something went wrong while loading this view."}</p>
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


export function MemoryView() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [boundaryKey, setBoundaryKey] = useState(0);
  /** Label of the currently focused entity (null = home/library) */
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  /** Callback to clear focus (go back to library) */
  const [onBack, setOnBack] = useState<(() => void) | null>(null);

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

  const handleRefresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  /** WikiLibrary reports its focus changes here */
  const handleFocusChange = useCallback((label: string | null, backFn: (() => void) | null) => {
    setFocusLabel(label);
    setOnBack(() => backFn);
  }, []);

  const handleBackClick = useCallback(() => {
    if (onBack) onBack();
  }, [onBack]);

  return (
    <div className="memory-view">
      <header className="wiki-topbar">
        <button
          type="button"
          className={`wiki-topbar__brand${focusLabel ? " wiki-topbar__brand--clickable" : ""}`}
          onClick={focusLabel ? handleBackClick : undefined}
          aria-label={focusLabel ? "Back to Memory library" : "Memory"}
        >
          <span className="wiki-topbar__logo" aria-hidden>
            <MemoryIcon size={14} />
          </span>
          <span>Memory</span>
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
                Library
              </button>
              <span className="wiki-topbar__sep">/</span>
              <span className="wiki-topbar__cur">{focusLabel}</span>
            </>
          ) : (
            <span className="wiki-topbar__cur">Library</span>
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
            try { sessionStorage.removeItem("memory-view-focus"); } catch { /* noop */ }
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
          />
        </MemoryErrorBoundary>
      </div>
    </div>
  );
}
