import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import type { JobType } from "../types.js";
import type { ExecutorLaunchParams, ExecutorLaunchResult, IJobExecutor } from "./IJobExecutor.js";

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
    const finalCommand = params.job.type === "python"
      ? this.wrapWithVenv(command, params.jobDir)
      : command;

    const proc = spawn("/bin/bash", ["-lc", finalCommand], {
      cwd: params.jobDir,
      env: { ...process.env, ...(params.runtimeParams ?? {}) },
    });

    return {
      mode: "process",
      command: finalCommand,
      process: proc,
    };
  }

  /**
   * Ensure a Python venv exists and requirements are installed.
   * Creates the venv only once; subsequent runs reuse it.
   * Installs from requirements.txt if present and changed.
   */
  private async ensurePythonVenv(params: ExecutorLaunchParams): Promise<void> {
    const venvDir = path.join(params.jobDir, ".venv");
    const requirementsFile = path.join(params.jobDir, "requirements.txt");
    const installedMarker = path.join(params.jobDir, ".venv", ".requirements-installed");

    // Create venv if it doesn't exist
    if (!existsSync(venvDir)) {
      await params.appendLog("Creating Python virtual environment...");
      try {
        execSync("python3 -m venv .venv", {
          cwd: params.jobDir,
          timeout: 30_000,
        });
        await params.appendLog("Virtual environment created.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await params.appendLog(`Failed to create venv: ${message}`);
        // Continue without venv — the job command may still work with system Python
        return;
      }
    }

    // Install requirements if requirements.txt exists and hasn't been installed yet
    // (or if the file changed since last install)
    if (existsSync(requirementsFile)) {
      const needsInstall = !existsSync(installedMarker) || this.requirementsChanged(requirementsFile, installedMarker);

      if (needsInstall) {
        await params.appendLog("Installing Python requirements...");
        try {
          const pipOutput = execSync(
            ".venv/bin/pip install -r requirements.txt 2>&1",
            {
              cwd: params.jobDir,
              timeout: 120_000, // 2 min timeout for pip
              encoding: "utf8",
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
          const message = error instanceof Error ? error.message : String(error);
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
  private requirementsChanged(requirementsFile: string, markerFile: string): boolean {
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
   * - `python3 script.py` → `.venv/bin/python3 script.py`
   * - Other commands get the venv activated via `source .venv/bin/activate`
   */
  private wrapWithVenv(command: string, jobDir: string): string {
    const venvDir = path.join(jobDir, ".venv");
    if (!existsSync(venvDir)) {
      return command;
    }

    // If command starts with `python`, replace with venv python
    if (command.startsWith("python3 ") || command.startsWith("python ")) {
      const rest = command.replace(/^python3?\s+/, "");
      return `.venv/bin/python3 ${rest}`;
    }

    // For pip commands, use venv pip
    if (command.startsWith("pip ") || command.startsWith("pip3 ")) {
      const rest = command.replace(/^pip3?\s+/, "");
      return `.venv/bin/pip3 ${rest}`;
    }

    // For anything else, activate venv first
    return `source .venv/bin/activate && ${command}`;
  }
}
