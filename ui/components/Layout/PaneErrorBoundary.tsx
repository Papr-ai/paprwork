/**
 * Contains a render-time throw to the tab it happened in.
 *
 * Without a boundary anywhere above them, the panes sat directly under
 * `AppLayout`, so React's only recourse for a throw in one of them was to
 * unmount the entire tree. To the user that looks like the whole app
 * reloading, and it takes every other tab down with it.
 *
 * The boundary is deliberately at the pane rather than around a single view:
 * one tab throwing should never be able to reach another, whichever kind of
 * view it holds.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import "./PaneErrorBoundary.css";

interface PaneErrorBoundaryProps {
  children: ReactNode;
  /** Identifies the pane in logs, and resets the boundary when the tab changes. */
  paneKey: string;
}

interface PaneErrorBoundaryState {
  error: Error | null;
}

export class PaneErrorBoundary extends Component<
  PaneErrorBoundaryProps,
  PaneErrorBoundaryState
> {
  state: PaneErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previous: PaneErrorBoundaryProps): void {
    // Switching tabs is a fresh start: keeping the error would leave a healthy
    // tab showing the previous tab's failure.
    if (previous.paneKey !== this.props.paneKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[Pane:${this.props.paneKey}] Render error:`,
      error,
      info.componentStack,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="pane-error">
        <div className="pane-error__card">
          <h2 className="pane-error__title">This tab hit an error</h2>
          <p className="pane-error__detail">
            {error.message || "Something went wrong while rendering this view."}
          </p>
          <p className="pane-error__reassurance">
            Your other tabs are unaffected, and any message you were typing has
            been saved.
          </p>
          <button
            type="button"
            className="pane-error__retry"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
