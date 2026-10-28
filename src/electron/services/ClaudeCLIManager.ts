/**
 * Claude CLI Manager - On-demand download and management of Claude CLI
 * 
 * Features:
 * - Auto-detects existing Claude CLI installations (global)
 * - Downloads Claude CLI from npm registry if needed (no npm command required!)
 * - Caches CLI in userData for future use
 * - Shows download progress in UI
 * - Works completely offline after initial download
 * 
 * Pattern: Similar to OllamaManager - download on first use, cache locally
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import * as tar from 'tar';
import {
  PORTABLE_GIT,
  findWindowsGitBash,
  managedGitBashPath,
  windowsClaudeExePath,
} from '../../core/services/claudeWindowsSetup.js';

const execAsync = promisify(exec);

interface DownloadProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  /** Human-readable phase, e.g. "Installing Git for Windows". */
  message?: string;
  total?: number;
  completed?: number;
  error?: string;
}

export class ClaudeCLIManager {
  private cliPath: string | null = null;
  private progressCallback: ((progress: DownloadProgress) => void) | null = null;

  // Claude CLI npm package info
  private readonly PACKAGE_NAME = '@anthropic-ai/claude-code';
  // macOS/Linux only. DO NOT BUMP blindly: current releases (e.g. 2.1.312)
  // ship a per-platform native binary instead of package/cli.js, so a newer
  // version here breaks this download path. Move to install.sh before upgrading.
  // Windows uses Anthropic's install.ps1 instead (see ensureWindowsCLI).
  private readonly PACKAGE_VERSION = '2.1.97';
  private readonly REGISTRY_URL = `https://registry.npmjs.org/${this.PACKAGE_NAME}/-/claude-code-${this.PACKAGE_VERSION}.tgz`;

  constructor() {
    console.log('[ClaudeCLIManager] Constructor called');
  }

  /**
   * Get the path to Claude CLI directory in userData
   */
  private getCLIDirectory(): string {
    return path.join(app.getPath('userData'), 'claude-cli');
  }

  /**
   * Get the path to the cached Claude CLI executable
   */
  private getCachedCLIPath(): string {
    return path.join(this.getCLIDirectory(), 'package', 'cli.js');
  }

  /**
   * Check if Claude CLI is installed globally
   */
  private async checkGlobalCLI(): Promise<string | null> {
    try {
      const whichCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const { stdout } = await execAsync(whichCmd, { timeout: 5000 });
      const cliPath = stdout.trim().split('\n')[0]; // First result
      
      if (cliPath && fs.existsSync(cliPath)) {
        console.log('[ClaudeCLIManager] Found global Claude CLI:', cliPath);
        return cliPath;
      }
    } catch (error) {
      // Not found, that's okay
    }
    return null;
  }

  /**
   * Check if cached CLI exists and is valid
   */
  private isCachedCLIValid(): boolean {
    const cachedPath = this.getCachedCLIPath();
    if (!fs.existsSync(cachedPath)) {
      return false;
    }

    // Check if it's a valid file and executable
    try {
      const stats = fs.statSync(cachedPath);
      return stats.isFile() && stats.size > 1000000; // Should be ~13MB
    } catch {
      return false;
    }
  }

  /**
   * Download Claude CLI from npm registry
   * Uses direct HTTPS download - NO npm command required!
   */
  private async downloadCLI(): Promise<void> {
    const cliDir = this.getCLIDirectory();
    const tarballPath = path.join(cliDir, 'claude-cli.tgz');

    // Create directory if needed
    if (!fs.existsSync(cliDir)) {
      fs.mkdirSync(cliDir, { recursive: true });
    }

    console.log('[ClaudeCLIManager] Downloading Claude CLI from npm registry...');
    console.log('[ClaudeCLIManager] URL:', this.REGISTRY_URL);

    this.emitProgress({ status: 'downloading', percent: 0 });

    return new Promise((resolve, reject) => {
      https.get(this.REGISTRY_URL, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        const fileStream = fs.createWriteStream(tarballPath);

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          this.emitProgress({
            status: 'downloading',
            percent,
            total: totalBytes,
            completed: downloadedBytes,
          });
        });

        response.pipe(fileStream);

        fileStream.on('finish', async () => {
          fileStream.close();
          console.log('[ClaudeCLIManager] Download complete, extracting...');
          
          this.emitProgress({ status: 'extracting', percent: 100 });

          try {
            // Extract tarball
            await tar.extract({
              file: tarballPath,
              cwd: cliDir,
            });

            // Clean up tarball
            fs.unlinkSync(tarballPath);

            console.log('[ClaudeCLIManager] Extraction complete');
            this.emitProgress({ status: 'complete', percent: 100 });
            resolve();
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error('[ClaudeCLIManager] Extraction failed:', errorMsg);
            this.emitProgress({ status: 'error', percent: 0, error: errorMsg });
            reject(error);
          }
        });

        fileStream.on('error', (error) => {
          console.error('[ClaudeCLIManager] File write error:', error);
          this.emitProgress({ status: 'error', percent: 0, error: error.message });
          reject(error);
        });
      }).on('error', (error) => {
        console.error('[ClaudeCLIManager] Download error:', error);
        this.emitProgress({ status: 'error', percent: 0, error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Emit progress update to registered callback
   */
  private emitProgress(progress: DownloadProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /**
   * Set progress callback for download updates
   */
  setProgressCallback(callback: (progress: DownloadProgress) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Clear progress callback
   */
  clearProgressCallback(): void {
    this.progressCallback = null;
  }

  /**
   * Ensure Claude CLI is available (download if needed)
   * Returns path to CLI executable
   */
  async ensureCLI(): Promise<string> {
    if (process.platform === 'win32') {
      return this.ensureWindowsCLI();
    }
    // 1. Check if we already resolved the path
    if (this.cliPath && fs.existsSync(this.cliPath)) {
      return this.cliPath;
    }

    // 2. Check for global installation
    const globalCLI = await this.checkGlobalCLI();
    if (globalCLI) {
      this.cliPath = globalCLI;
      return globalCLI;
    }

    // 3. Check cached version
    if (this.isCachedCLIValid()) {
      const cachedPath = this.getCachedCLIPath();
      console.log('[ClaudeCLIManager] Using cached CLI:', cachedPath);
      this.cliPath = cachedPath;
      return cachedPath;
    }

    // 4. Download from npm registry
    console.log('[ClaudeCLIManager] CLI not found, downloading...');
    await this.downloadCLI();

    // 5. Verify download succeeded
    if (!this.isCachedCLIValid()) {
      throw new Error('CLI download completed but file is invalid or missing');
    }

    const cachedPath = this.getCachedCLIPath();
    this.cliPath = cachedPath;
    return cachedPath;
  }

  /**
   * Check if CLI is available (global or cached)
   */
  async isAvailable(): Promise<boolean> {
    if (process.platform === 'win32') {
      return (await this.findWindowsClaude()) !== null;
    }
    try {
      const globalCLI = await this.checkGlobalCLI();
      if (globalCLI) return true;

      return this.isCachedCLIValid();
    } catch {
      return false;
    }
  }

  /**
   * Get CLI version (if available)
   */
  async getVersion(): Promise<string | null> {
    try {
      const cliPath = await this.ensureCLI();
      const versionCmd = cliPath.endsWith(".js")
        ? `node "${cliPath}" --version`
        : `"${cliPath}" --version`;
      const { stdout } = await execAsync(versionCmd, { timeout: 5000 });
      return stdout.trim().split(/\r?\n/)[0]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Windows: official install.ps1 (native claude.exe) + Papr-managed Git Bash.
  // ---------------------------------------------------------------------------

  private getManagedGitDir(): string {
    return path.join(app.getPath('userData'), 'git-portable');
  }

  private async whereOnWindows(name: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`where ${name}`, { timeout: 5000 });
      const first = stdout.trim().split(/\r?\n/)[0]?.trim();
      return first && fs.existsSync(first) ? first : null;
    } catch {
      return null;
    }
  }

  /** claude.exe from install.ps1's folder first (Electron's PATH is stale), then PATH. */
  private async findWindowsClaude(): Promise<string | null> {
    const direct = windowsClaudeExePath(os.homedir());
    if (fs.existsSync(direct)) return direct;
    return this.whereOnWindows('claude');
  }

  /** bash.exe Claude Code will use, or null when none is installed. */
  async getWindowsGitBashPath(): Promise<string | null> {
    if (process.platform !== 'win32') return null;
    return findWindowsGitBash({
      env: process.env,
      exists: (p) => fs.existsSync(p),
      gitOnPath: await this.whereOnWindows('git'),
      managedGitDir: this.getManagedGitDir(),
    });
  }

  private async ensureWindowsCLI(): Promise<string> {
    await this.ensureWindowsGitBash();

    const existing = await this.findWindowsClaude();
    if (existing) {
      this.cliPath = existing;
      return existing;
    }

    this.emitProgress({ status: 'downloading', percent: 0, message: 'Installing Claude Code' });
    await this.runInstallPs1();

    const installed = await this.findWindowsClaude();
    if (!installed) {
      const error = 'Claude Code installer finished but claude.exe was not found.';
      this.emitProgress({ status: 'error', percent: 0, error });
      throw new Error(error);
    }
    this.emitProgress({ status: 'complete', percent: 100 });
    this.cliPath = installed;
    return installed;
  }

  /** Runs Anthropic's installer exactly as documented, without execution-policy prompts. */
  private runInstallPs1(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://claude.ai/install.ps1 | iex',
        ],
        { windowsHide: true },
      );
      let output = '';
      const onData = (d: Buffer) => {
        output += d.toString();
        console.log('[ClaudeCLIManager] install.ps1:', d.toString().trim());
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Claude Code install timed out after 5 minutes. Check your connection and try again.'));
      }, 5 * 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        // Surface the installer's own message (region block, 32-bit, checksum…).
        const lastLines = output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        reject(new Error(lastLines || `Claude Code installer exited with code ${code}`));
      });
    });
  }

  /**
   * Make sure Claude Code can find Git Bash. Uses an existing Git for Windows
   * when present; otherwise downloads PortableGit (no admin, no installer UI)
   * into userData and points CLAUDE_CODE_GIT_BASH_PATH at it for this process
   * and the user's future terminals.
   */
  private async ensureWindowsGitBash(): Promise<string> {
    const found = await this.getWindowsGitBashPath();
    if (found) {
      if (found.startsWith(this.getManagedGitDir())) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = found;
      }
      return found;
    }

    const gitDir = this.getManagedGitDir();
    const sfxPath = path.join(app.getPath('userData'), 'PortableGit.7z.exe');
    fs.mkdirSync(path.dirname(sfxPath), { recursive: true });

    this.emitProgress({ status: 'downloading', percent: 0, message: 'Installing Git for Windows' });
    await this.downloadFile(PORTABLE_GIT.url, sfxPath, 'Installing Git for Windows');

    const hash = crypto.createHash('sha256').update(fs.readFileSync(sfxPath)).digest('hex');
    if (hash !== PORTABLE_GIT.sha256) {
      fs.rmSync(sfxPath, { force: true });
      throw new Error('Git for Windows download failed verification. Please try again.');
    }

    this.emitProgress({ status: 'extracting', percent: 100, message: 'Installing Git for Windows' });
    fs.rmSync(gitDir, { recursive: true, force: true });
    // 7-Zip self-extractor: -o<dir> (no space) and -y for silent.
    await execAsync(`"${sfxPath}" -o"${gitDir}" -y`, { timeout: 5 * 60_000 });
    fs.rmSync(sfxPath, { force: true });

    const bash = managedGitBashPath(gitDir);
    if (!fs.existsSync(bash)) {
      throw new Error('Git for Windows was extracted but bash.exe is missing.');
    }

    process.env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    try {
      // User-scope env var so `claude` works in the user's own terminals too.
      await execAsync(`setx CLAUDE_CODE_GIT_BASH_PATH "${bash}"`, { timeout: 10_000 });
    } catch (err) {
      console.warn('[ClaudeCLIManager] setx CLAUDE_CODE_GIT_BASH_PATH failed:', err);
    }
    return bash;
  }

  /** HTTPS download following redirects (GitHub release assets redirect). */
  private downloadFile(url: string, dest: string, message: string, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'User-Agent': 'PaprWork' } }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
            res.resume();
            this.downloadFile(res.headers.location, dest, message, redirects + 1).then(resolve, reject);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Download failed with status ${status}`));
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let done = 0;
          const file = fs.createWriteStream(dest);
          res.on('data', (chunk: Buffer) => {
            done += chunk.length;
            this.emitProgress({
              status: 'downloading',
              percent: total > 0 ? Math.round((done / total) * 100) : 0,
              total,
              completed: done,
              message,
            });
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    });
  }

  /**
   * Clear cached CLI (force re-download on next use)
   */
  clearCache(): void {
    const cliDir = this.getCLIDirectory();
    if (fs.existsSync(cliDir)) {
      fs.rmSync(cliDir, { recursive: true, force: true });
      console.log('[ClaudeCLIManager] Cache cleared');
    }
    this.cliPath = null;
  }
}

// Singleton instance
let instance: ClaudeCLIManager | null = null;

/**
 * Get singleton ClaudeCLIManager instance
 */
export function getClaudeCLIManager(): ClaudeCLIManager {
  if (!instance) {
    instance = new ClaudeCLIManager();
  }
  return instance;
}
