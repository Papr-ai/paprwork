import React, { useEffect } from "react";

interface PythonDependencyStatus {
  pythonInstalled: boolean;
  pythonVersion?: string;
  beautifulSoupInstalled: boolean;
  lxmlInstalled: boolean;
  canAutoInstall: boolean;
}

/**
 * Silent background installer for Python dependencies (BeautifulSoup4, lxml)
 * 
 * No UI shown - everything happens automatically in background.
 * Required for browser_parse_html tool functionality.
 */
export const PythonDepsSetup: React.FC = () => {
  useEffect(() => {
    checkAndAutoInstall();
  }, []);

  async function checkAndAutoInstall() {
    try {
      const result = await window.electronAPI.pythonDeps.check();
      if (result.success) {
        // Auto-install in background if Python is installed but packages are missing
        if (
          result.status.pythonInstalled &&
          result.status.canAutoInstall &&
          (!result.status.beautifulSoupInstalled || !result.status.lxmlInstalled)
        ) {
          console.log(
            "[PythonDepsSetup] Auto-installing missing Python dependencies in background..."
          );
          handleAutoInstall();
        } else if (result.status.beautifulSoupInstalled && result.status.lxmlInstalled) {
          console.log("[PythonDepsSetup] All Python dependencies already installed");
        } else if (!result.status.pythonInstalled) {
          console.warn(
            "[PythonDepsSetup] Python not installed - cannot auto-install dependencies"
          );
        }
      }
    } catch (error) {
      console.error("[PythonDepsSetup] Failed to check Python dependencies:", error);
    }
  }

  async function handleAutoInstall() {
    try {
      const result = await window.electronAPI.pythonDeps.autoInstall();

      if (result.success) {
        console.log("[PythonDepsSetup] ✓ Python dependencies installed successfully");
      } else {
        console.warn(
          "[PythonDepsSetup] Failed to auto-install Python dependencies:",
          result.error
        );
      }
    } catch (error) {
      console.error("[PythonDepsSetup] Auto-install failed:", error);
    }
  }

  // Never show UI - everything happens silently in background
  return null;
};
