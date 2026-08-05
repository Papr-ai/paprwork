import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import type { JobType } from "../types.js";
import { runtimeParamsForJobEnv } from "../../../utils/normalizeRuntimeParams.js";
import type {
  ExecutorLaunchParams,
  ExecutorLaunchResult,
  IJobExecutor,
} from "./IJobExecutor.js";
import { getShellCommand, wrapCommandWithVenv, getVenvPaths } from "../../../../core/utils/platform.js";
import {
  jobWriteDatabaseEnv,
  requireJobWriteTargets,
} from "../../jobAppDatabase.js";
import { STANDALONE_APP_ID } from "../appIds.js";

export class CommandJobExecutor implements IJobExecutor {
  private supportedTypes: Set<JobType>;

  constructor(types: JobType[]) {
    this.supportedTypes = new Set(types);
  }

  canExecute(type: JobType): boolean {
    return this.supportedTypes.has(type);
  }

  async launch(params: ExecutorLaunchParams): Promise<ExecutorLaunchResult> {
    if (params.job.type === "agent" || params.job.type === "subagent") {
      throw new Error("CommandJobExecutor cannot execute agent jobs");
    }

    const command =
      params.job.command || params.defaultCommandByType[params.job.type];
    if (!command) {
      throw new Error(`Missing command for job type: ${params.job.type}`);
    }

    // ── Auto-setup venv + pip install for Python/Node jobs ────────────────────
    if (params.job.type === "python") {
      await this.ensurePythonVenv(params);
    } else if (params.job.type === "node") {
      await this.ensureNodeModules(params);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Wrap command with venv activation for Python jobs
    let finalCommand =
      params.job.type === "python"
        ? this.wrapWithVenv(command, params.jobDir)
        : command;

    // ── Substitute custom API keys (${KEY_NAME} syntax) ───────────────────────
    // Jobs bypass the bash tool, so we need to substitute keys here
    // For "ask" keys, requests permission before substituting
    let sanitizationValues: string[] = [];
    try {
      const result = await this.substituteCustomKeys(finalCommand, params);
      finalCommand = result.command;
      sanitizationValues = result.sanitizationValues;
      // Do NOT inject customKeys into env - that's a security risk!
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to substitute API keys: ${message}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const jobDbPath = path.join(params.jobDir, "data", "data.db");
    const [shellPath, shellArgs] = getShellCommand(finalCommand);

    const writeTargets = await requireJobWriteTargets(params.job);
    const linkedAppId = (params.job.appIds ?? []).find(
      (id) => id !== STANDALONE_APP_ID,
    );

    const env: NodeJS.ProcessEnv = {
      ...this.getNvmEnv(),
      JOB_DIR: params.jobDir,
      JOB_DB: jobDbPath,
      ...(writeTargets.length > 0
        ? jobWriteDatabaseEnv(writeTargets, linkedAppId)
        : {}),
      ...(runtimeParamsForJobEnv(params.runtimeParams)),
    };
    
    const proc = spawn(shellPath, shellArgs, {
      cwd: params.jobDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      mode: "process",
      command: finalCommand,
      process: proc,
      sanitizationValues,
    };
  }

  /**
   * Substitute custom API keys in command (${KEY_NAME} syntax).
   * Loads keys from both environment AND CustomKeysStorage.
   * For keys with permission "ask", requests user approval before substituting.
   *
   * SECURITY: Keys are ONLY substituted in command string, NOT injected into env.
   *
   * @returns Object with substituted command
   * @throws Error if permission denied for an "ask" key
   */
  private async substituteCustomKeys(
    command: string,
    params: ExecutorLaunchParams,
  ): Promise<{ command: string; sanitizationValues: string[] }> {
    const customKeys: Record<string, string> = {};
    const job = params.job;

    // 1. Add keys from environment
    const commonKeyVars = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "PAPR_API_KEY",
      "GOOGLE_API_KEY",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
    ];
    for (const varName of commonKeyVars) {
      const value = process.env[varName];
      if (value) customKeys[varName] = value;
    }

    // 2. Add keys from CustomKeysStorage (Settings)
    const askKeys: string[] = [];
    try {
      const { getCustomKeysService } =
        await import("../../../services/CustomKeysService.js");
      const service = getCustomKeysService();
      const storedKeys = await service.listKeys();

      for (const keyMeta of storedKeys) {
        if (!command.includes(`\${${keyMeta.name}}`)) continue;

        const value = await service.getKeyByName(keyMeta.name);
        if (!value) continue;

        const permission =
          (keyMeta as { permission?: string }).permission ?? "always";
        if (permission === "always") {
          customKeys[keyMeta.name] = value;
        } else if (permission === "ask") {
          askKeys.push(keyMeta.name);
        }
      }
    } catch (error) {
      console.warn("[CommandJobExecutor] Failed to load custom keys:", error);
    }

    // 3. Request permission for "ask" keys
    if (askKeys.length > 0 && params.requestKeyPermission) {
      await params.onWaitingPermission?.(askKeys);

      for (const keyName of askKeys) {
        const approved = await params.requestKeyPermission(keyName, {
          jobId: job.id,
          jobName: job.name,
        });
        if (!approved) {
          throw new Error(
            `Job "${job.name}" requires permission for API key ${keyName}. ` +
              `User denied. Change the key to "Always allow" in Settings → API Keys, or run the job again to approve.`,
          );
        }
        const { getCustomKeysService } =
          await import("../../../services/CustomKeysService.js");
        const value = await getCustomKeysService().getKeyByName(keyName);
        if (value) customKeys[keyName] = value;
      }

      await params.onResumingAfterPermission?.();
    } else if (askKeys.length > 0 && !params.requestKeyPermission) {
      throw new Error(
        `Job "${job.name}" needs permission for: ${askKeys.join(", ")}. ` +
          `Run from chat or use an app with permission prompts. Or change keys to "Always allow" in Settings → API Keys.`,
      );
    }

    // 4. Substitute ${KEY_NAME} with actual values
    let result = command;
    if (command.includes("${")) {
      for (const [name, value] of Object.entries(customKeys)) {
        if (value && value.length > 0) {
          const regex = new RegExp(`\\$\\{${this.escapeRegex(name)}\\}`, "g");
          result = result.replace(regex, value);
        }
      }
    }
    const sanitizationValues = Object.values(customKeys).filter(
      (value) => value.length > 0,
    );
    return { command: result, sanitizationValues };
  }

  /**
   * Escape special regex characters for safe regex creation.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Ensure a Python venv exists and requirements are installed.
   * Creates the venv only once; subsequent runs reuse it.
   * Installs from requirements.txt if present and changed.
   */
  private async ensurePythonVenv(params: ExecutorLaunchParams): Promise<void> {
    const venvDir = path.join(params.jobDir, ".venv");
    const requirementsFile = path.join(params.jobDir, "requirements.txt");
    const installedMarker = path.join(
      params.jobDir,
      ".venv",
      ".requirements-installed",
    );

    // Create venv if it doesn't exist
    if (!existsSync(venvDir)) {
      await params.appendLog("Creating Python virtual environment...");
      try {
        const pythonCmd = await this.getPythonCommand();
        
        // Check if Python is actually available
        const testResult = execSync(`${pythonCmd} --version 2>&1`, {
          timeout: 5000,
          encoding: 'utf8',
          env: this.getNvmEnv(),
        }).trim();
        
        await params.appendLog(`Using Python: ${testResult}`);
        
        execSync(`${pythonCmd} -m venv .venv`, {
          cwd: params.jobDir,
          timeout: 30_000,
          env: this.getNvmEnv(),
        });
        await params.appendLog("Virtual environment created.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        
        // Enhanced error message for Windows users
        if (process.platform === 'win32' && message.includes('not found')) {
          await params.appendLog(
            `Failed to create venv: Python not found.\n\n` +
            `Python will be installed automatically when you restart the app.\n` +
            `Or install manually from: https://www.python.org/downloads/windows/\n` +
            `Make sure to check "Add to PATH" during installation.`
          );
        } else {
          await params.appendLog(`Failed to create venv: ${message}`);
        }
        // Continue without venv — the job command may still work with system Python
        return;
      }
    }

    // Install requirements if requirements.txt exists and hasn't been installed yet
    // (or if the file changed since last install)
    if (existsSync(requirementsFile)) {
      const needsInstall =
        !existsSync(installedMarker) ||
        this.requirementsChanged(requirementsFile, installedMarker);

      if (needsInstall) {
        await params.appendLog("Installing Python requirements...");
        try {
          const { pip } = getVenvPaths(venvDir);
          const pipOutput = execSync(
            `${pip} install -r requirements.txt 2>&1`,
            {
              cwd: params.jobDir,
              timeout: 120_000, // 2 min timeout for pip
              encoding: "utf8",
              env: this.getNvmEnv(),
            },
          );
          // Log last few lines of pip output (skip the verbose download lines)
          const lines = pipOutput.trim().split("\n");
          const tail = lines.slice(-5).join("\n");
          await params.appendLog(`pip install output:\n${tail}`);

          // Write marker so we don't re-install on every run
          const { writeFileSync, readFileSync } = await import("fs");
          const reqContent = readFileSync(requirementsFile, "utf8");
          writeFileSync(installedMarker, reqContent, "utf8");

          await params.appendLog("Requirements installed successfully.");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await params.appendLog(`pip install failed: ${message}`);
          // Don't throw — let the job try to run and fail naturally
        }
      } else {
        await params.appendLog("Requirements already installed (unchanged).");
      }
    }
  }

  /**
   * Check if requirements.txt has changed since last install.
   */
  private requirementsChanged(
    requirementsFile: string,
    markerFile: string,
  ): boolean {
    try {
      const { readFileSync } = require("fs") as typeof import("fs");
      const current = readFileSync(requirementsFile, "utf8");
      const installed = readFileSync(markerFile, "utf8");
      return current !== installed;
    } catch {
      return true; // If we can't read, assume changed
    }
  }

  /**
   * Ensure node_modules exists for Node jobs with a package.json.
   */
  private async ensureNodeModules(params: ExecutorLaunchParams): Promise<void> {
    const packageJson = path.join(params.jobDir, "package.json");
    const nodeModules = path.join(params.jobDir, "node_modules");

    if (existsSync(packageJson) && !existsSync(nodeModules)) {
      await params.appendLog("Installing Node dependencies...");
      try {
        execSync("npm install --production 2>&1", {
          cwd: params.jobDir,
          timeout: 120_000,
          encoding: "utf8",
          env: this.getNvmEnv(),
        });
        await params.appendLog("Node dependencies installed.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await params.appendLog(`npm install failed: ${message}`);
      }
    }
  }

  /**
   * Wrap a command to use the job's venv Python if it exists.
   * - `python3 script.py` → `.venv/bin/python3 script.py` (Unix) or `.venv\Scripts\python.exe script.py` (Windows)
   * - Other commands get the venv activated via platform-specific activation script
   */
  private wrapWithVenv(command: string, jobDir: string): string {
    const venvDir = path.join(jobDir, ".venv");
    if (!existsSync(venvDir)) {
      return command;
    }

    return wrapCommandWithVenv(command, venvDir);
  }

  /**
   * Get the appropriate Python command for the current platform.
   * On Windows, attempts auto-install if Python not found.
   * - Windows: 'python' (modern installations alias python3 as python)
   * - Unix: 'python3' (explicit version to avoid Python 2)
   */
  private async getPythonCommand(): Promise<string> {
    if (process.platform === "win32") {
      // On Windows, check if Python exists, auto-install if missing
      try {
        const { execSync } = await import('child_process');
        // Try 'python' first (most common)
        try {
          execSync('python --version', { timeout: 5000, stdio: 'pipe' });
          return "python";
        } catch {
          // Try 'py' launcher
          try {
            execSync('py --version', { timeout: 5000, stdio: 'pipe' });
            return "py -3";
          } catch {
            // Python not found - return 'python' and let the error handling deal with it
            // The error message will guide users to install Python
            console.warn('[CommandJobExecutor] Python not found on Windows');
            return "python";
          }
        }
      } catch (error) {
        console.error('[CommandJobExecutor] Failed to check Python:', error);
        return "python";
      }
    }
    // Unix-like systems: use python3 explicitly to avoid Python 2
    return "python3";
  }

  /**
   * Get environment with correct Node version from nvm.
   * Ensures jobs use the Node version specified in .nvmrc to prevent native module mismatches.
   */
  private getNvmEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    
    // Windows uses nvm-windows with different structure, Unix uses nvm
    const isWindows = process.platform === 'win32';
    const pathSeparator = isWindows ? ';' : ':';
    
    if (isWindows) {
      // Windows: nvm-windows uses NVM_HOME or NVM_SYMLINK
      const nvmHome = process.env.NVM_HOME || process.env.NVM_SYMLINK;
      if (nvmHome && existsSync(nvmHome)) {
        // nvm-windows creates a symlink at NVM_SYMLINK pointing to the active version
        // Just ensure it's in PATH
        const currentPath = env.PATH || '';
        if (!currentPath.includes(nvmHome)) {
          env.PATH = `${nvmHome}${pathSeparator}${currentPath}`;
        }
      }
    } else {
      // Unix: Use nvm with .nvmrc version
      const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
      const nvmrcPath = path.join(process.cwd(), '.nvmrc');
      
      if (existsSync(nvmDir) && existsSync(nvmrcPath)) {
        try {
          const { readFileSync } = require('fs') as typeof import('fs');
          const nvmVersion = readFileSync(nvmrcPath, 'utf8').trim();
          const nvmNodePath = path.join(nvmDir, 'versions', 'node', `v${nvmVersion}`, 'bin');
          
          if (existsSync(nvmNodePath)) {
            // Prepend nvm's Node path to ensure it takes priority over system Node
            env.PATH = `${nvmNodePath}${pathSeparator}${env.PATH || ''}`;
          }
        } catch {
          // If we can't read .nvmrc, just use current environment
        }
      }
    }
    
    return env;
  }
}
