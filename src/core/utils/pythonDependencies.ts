import { execSync, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface PythonDependencyStatus {
  pythonInstalled: boolean;
  pythonVersion?: string;
  beautifulSoupInstalled: boolean;
  lxmlInstalled: boolean;
  canAutoInstall: boolean;
}

/**
 * Check if Python and required dependencies are installed
 */
export async function checkPythonDependencies(): Promise<PythonDependencyStatus> {
  const status: PythonDependencyStatus = {
    pythonInstalled: false,
    beautifulSoupInstalled: false,
    lxmlInstalled: false,
    canAutoInstall: false,
  };

  // Check Python 3
  try {
    const version = execSync("python3 --version", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    status.pythonInstalled = true;
    status.pythonVersion = version;
    status.canAutoInstall = true;
  } catch {
    // Try 'python' command on Windows
    try {
      const version = execSync("python --version", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (version.includes("Python 3")) {
        status.pythonInstalled = true;
        status.pythonVersion = version;
        status.canAutoInstall = true;
      }
    } catch {
      return status;
    }
  }

  // Check BeautifulSoup
  try {
    execSync("python3 -c 'import bs4'", { stdio: "ignore" });
    status.beautifulSoupInstalled = true;
  } catch {
    try {
      execSync("python -c 'import bs4'", { stdio: "ignore" });
      status.beautifulSoupInstalled = true;
    } catch {
      // Not installed
    }
  }

  // Check lxml
  try {
    execSync("python3 -c 'import lxml'", { stdio: "ignore" });
    status.lxmlInstalled = true;
  } catch {
    try {
      execSync("python -c 'import lxml'", { stdio: "ignore" });
      status.lxmlInstalled = true;
    } catch {
      // Not installed
    }
  }

  return status;
}

export interface InstallProgress {
  stage: "installing" | "verifying" | "complete" | "error";
  message: string;
  progress?: number;
}

/**
 * Auto-install BeautifulSoup and lxml using pip
 * Returns progress updates via callback
 */
export async function autoInstallPythonDependencies(
  onProgress: (progress: InstallProgress) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress({
      stage: "installing",
      message: "Installing BeautifulSoup4 and lxml...",
      progress: 0,
    });

    // Try python3 first, fallback to python
    const pythonCmd = await (async () => {
      try {
        execSync("python3 --version", { stdio: "ignore" });
        return "python3";
      } catch {
        return "python";
      }
    })();

    // Check if we're in a virtualenv
    const isVirtualEnv = await (async () => {
      try {
        const result = execSync(`${pythonCmd} -c "import sys; print(hasattr(sys, 'real_prefix') or (hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix))"`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return result === "True";
      } catch {
        return false;
      }
    })();

    // Use --user flag only if NOT in virtualenv
    // In virtualenv, --user causes "User site-packages are not visible" error
    // On macOS with PEP 668 (externally-managed-environment), --user alone fails
    // so we add --break-system-packages as fallback
    const userFlag = isVirtualEnv ? "" : "--user";
    let installCmd = `${pythonCmd} -m pip install ${userFlag} beautifulsoup4 lxml`.replace(/\s+/g, ' ').trim();

    // Check if PEP 668 applies (macOS Homebrew / system Python)
    if (!isVirtualEnv && process.platform === "darwin") {
      try {
        execSync(`${pythonCmd} -m pip install --user --dry-run beautifulsoup4 2>&1`, {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
        });
      } catch (pipErr: unknown) {
        const errMsg = pipErr instanceof Error ? (pipErr as { stderr?: string }).stderr || pipErr.message : String(pipErr);
        if (errMsg.includes("externally-managed") || errMsg.includes("PEP 668")) {
          installCmd = `${pythonCmd} -m pip install --break-system-packages beautifulsoup4 lxml`;
          console.log("[PythonDeps] PEP 668 detected, using --break-system-packages");
        }
      }
    }

    console.log(`[PythonDeps] Installing with command: ${installCmd}`);
    console.log(`[PythonDeps] Virtualenv detected: ${isVirtualEnv}`);

    await execAsync(installCmd, {
      timeout: 120000, // 2 minute timeout
    });

    onProgress({
      stage: "verifying",
      message: "Verifying installation...",
      progress: 80,
    });

    // Verify installation
    try {
      execSync(`${pythonCmd} -c 'import bs4; import lxml'`, {
        stdio: "ignore",
      });

      onProgress({
        stage: "complete",
        message: "Installation complete!",
        progress: 100,
      });

      return { success: true };
    } catch {
      return {
        success: false,
        error: "Installation completed but packages not found. Try manually: pip3 install beautifulsoup4 lxml",
      };
    }
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : String(error);
    onProgress({
      stage: "error",
      message: `Installation failed: ${errorMsg}`,
    });

    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Get user-friendly status message
 */
export function getPythonStatusMessage(
  status: PythonDependencyStatus,
): string {
  if (!status.pythonInstalled) {
    return "Python 3 not found. Please install from https://www.python.org/downloads/";
  }

  if (!status.beautifulSoupInstalled) {
    return "BeautifulSoup4 not found. Required for browser_parse_html tool.";
  }

  if (!status.lxmlInstalled) {
    return "lxml not found (optional but recommended for faster parsing).";
  }

  return "All Python dependencies installed.";
}
