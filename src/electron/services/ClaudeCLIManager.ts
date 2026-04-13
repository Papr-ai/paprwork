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
import { exec } from 'child_process';
import * as tar from 'tar';

const execAsync = promisify(exec);

interface DownloadProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  total?: number;
  completed?: number;
  error?: string;
}

export class ClaudeCLIManager {
  private cliPath: string | null = null;
  private progressCallback: ((progress: DownloadProgress) => void) | null = null;

  // Claude CLI npm package info
  private readonly PACKAGE_NAME = '@anthropic-ai/claude-code';
  private readonly PACKAGE_VERSION = '2.1.97'; // Latest as of 2026-04-08
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
      const { stdout } = await execAsync(`node "${cliPath}" --version`, { timeout: 5000 });
      return stdout.trim();
    } catch {
      return null;
    }
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
