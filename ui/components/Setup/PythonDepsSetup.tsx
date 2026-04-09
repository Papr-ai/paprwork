import React, { useState, useEffect } from "react";
import "./PythonDepsSetup.css";

interface PythonDependencyStatus {
  pythonInstalled: boolean;
  pythonVersion?: string;
  beautifulSoupInstalled: boolean;
  lxmlInstalled: boolean;
  canAutoInstall: boolean;
}

interface InstallProgress {
  stage: "installing" | "verifying" | "complete" | "error";
  message: string;
  progress?: number;
}

export const PythonDepsSetup: React.FC = () => {
  const [status, setStatus] = useState<PythonDependencyStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkDependencies();

    // Note: Progress updates are handled via IPC events in the main process
    // We rely on the check/install promise flow instead of streaming updates
  }, []);

  async function checkDependencies() {
    setChecking(true);
    try {
      const result = await window.electronAPI.pythonDeps.check();
      if (result.success) {
        setStatus(result.status);
      }
    } catch (error) {
      console.error("Failed to check Python dependencies:", error);
    } finally {
      setChecking(false);
    }
  }

  async function handleAutoInstall() {
    setInstalling(true);
    setProgress({ stage: "installing", message: "Installing BeautifulSoup4 and lxml...", progress: 50 });

    try {
      const result = await window.electronAPI.pythonDeps.autoInstall();

      if (result.success) {
        setProgress({
          stage: "complete",
          message: "Installation complete!",
          progress: 100,
        });
        // Re-check status after installation
        await checkDependencies();
        // Auto-dismiss after 2 seconds
        setTimeout(() => setDismissed(true), 2000);
      } else {
        setProgress({
          stage: "error",
          message: result.error || "Installation failed. Try manually: pip3 install beautifulsoup4 lxml",
        });
      }
    } catch (error) {
      console.error("Auto-install failed:", error);
      setProgress({
        stage: "error",
        message: error instanceof Error ? error.message : "Installation failed. Try manually: pip3 install beautifulsoup4 lxml",
      });
    } finally {
      setInstalling(false);
    }
  }

  function handleDismiss() {
    setDismissed(true);
  }

  // Don't show if checking, all dependencies installed, or dismissed
  if (
    checking ||
    !status ||
    (status.beautifulSoupInstalled && status.lxmlInstalled) ||
    dismissed
  ) {
    return null;
  }

  // Don't show if Python not installed (can't auto-install)
  if (!status.pythonInstalled) {
    return (
      <div className="python-deps-banner python-deps-error">
        <div className="python-deps-content">
          <span className="python-deps-icon">⚠️</span>
          <div className="python-deps-text">
            <strong>Python 3 not found.</strong> Required for browser_parse_html
            tool.
            <a
              href="https://www.python.org/downloads/"
              target="_blank"
              rel="noopener noreferrer"
              className="python-deps-link"
            >
              Install Python 3
            </a>
          </div>
          <button onClick={handleDismiss} className="python-deps-dismiss">
            ×
          </button>
        </div>
      </div>
    );
  }

  // Show installation prompt
  return (
    <div className="python-deps-banner">
      <div className="python-deps-content">
        <span className="python-deps-icon">🐍</span>
        <div className="python-deps-text">
          {!installing && !progress && (
            <>
              <strong>Optional Setup:</strong> Install BeautifulSoup4 for HTML
              parsing in browser tools?
              <span className="python-deps-version">
                (Python {status.pythonVersion})
              </span>
            </>
          )}
          {progress && (
            <>
              <strong>{progress.message}</strong>
              {progress.progress !== undefined && (
                <div className="python-deps-progress">
                  <div
                    className="python-deps-progress-bar"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
        {!installing && !progress && (
          <div className="python-deps-actions">
            <button
              onClick={handleAutoInstall}
              className="python-deps-install-btn"
            >
              Install Now
            </button>
            <button onClick={handleDismiss} className="python-deps-dismiss-btn">
              Maybe Later
            </button>
          </div>
        )}
        {progress?.stage === "complete" && (
          <button onClick={handleDismiss} className="python-deps-dismiss">
            ✓
          </button>
        )}
      </div>
    </div>
  );
};
