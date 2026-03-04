/**
 * Ollama Manager - Auto-installs and manages Ollama for local AI inference
 * 
 * Features:
 * - Auto-detects existing Ollama installations
 * - Downloads and installs Ollama binaries if needed
 * - Auto-pulls models on first use
 * - Shows download progress in UI
 * - Works completely offline after initial setup
 */

import { app } from 'electron';
import { ElectronOllama } from 'electron-ollama';
import path from 'path';

interface ModelDownloadProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  total?: number;
  completed?: number;
  error?: string;
}

export class OllamaManager {
  private ollama: ElectronOllama | null = null;
  private initialized = false;
  private installingModels = new Set<string>();
  private progressCallbacks = new Map<string, (progress: ModelDownloadProgress) => void>();

  constructor() {
    // Note: Actual initialization happens in initialize() method
    // Ollama binaries stored in user data directory
    console.log('[OllamaManager] Constructor called');
  }

  /**
   * Initialize Ollama manager (lazy)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const basePath = app.getPath('userData');
      
      // Set OLLAMA_MODELS to use shared location across app versions
      // This ensures models downloaded with older versions are accessible
      const homeDir = app.getPath('home');
      process.env.OLLAMA_MODELS = path.join(homeDir, '.ollama', 'models');
      console.log(`[OllamaManager] OLLAMA_MODELS set to: ${process.env.OLLAMA_MODELS}`);
      
      // Create ElectronOllama instance
      this.ollama = new ElectronOllama({
        basePath,
        directory: 'ollama', // Subdirectory within userData
      });

      console.log('[OllamaManager] Initialized successfully');
      this.initialized = true;
    } catch (error) {
      console.error('[OllamaManager] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Check if Ollama is running (either existing installation or our managed one)
   */
  async isRunning(): Promise<boolean> {
    try {
      // Try to connect to Ollama API
      const response = await fetch('http://localhost:11434/api/tags', {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start Ollama service (auto-installs if needed)
   * Returns true if started successfully, false if already running
   */
  async start(onProgress?: (message: string) => void): Promise<boolean> {
    await this.initialize();

    if (!this.ollama) {
      throw new Error('Ollama not initialized');
    }

    // Check if already running (existing installation)
    if (await this.ollama.isRunning()) {
      console.log('[OllamaManager] Ollama already running (existing installation)');
      return false;
    }

    console.log('[OllamaManager] Starting Ollama service...');
    if (onProgress) {
      onProgress('Installing Ollama (this may take a few minutes)...');
    }
    
    try {
      // Get latest Ollama version metadata
      console.log('[OllamaManager] Fetching Ollama metadata...');
      const metadata = await this.ollama.getMetadata('latest');
      console.log(`[OllamaManager] Got metadata for version: ${metadata.version}`);
      
      // Serve Ollama with the latest version
      // NOTE: This downloads Ollama binaries (~100-500MB) on first run
      console.log('[OllamaManager] Calling ollama.serve()...');
      await this.ollama.serve(metadata.version, {
        serverLog: (message: string) => {
          console.log('[Ollama]', message);
          if (onProgress && message.includes('Downloading')) {
            onProgress(`Installing Ollama: ${message}`);
          }
        },
        downloadLog: (percent: number, message: string) => {
          console.log(`[Ollama Download] ${percent}%: ${message}`);
          if (onProgress) {
            onProgress(`Installing Ollama: ${Math.round(percent)}%`);
          }
        },
      });
      
      console.log('[OllamaManager] ollama.serve() completed');

      console.log('[OllamaManager] Ollama binary started, waiting for API to be ready...');
      
      // Wait for Ollama API to actually be ready (poll with timeout)
      const maxWaitMs = 30000; // 30 seconds max
      const pollIntervalMs = 500; // Check every 500ms
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitMs) {
        if (await this.isRunning()) {
          console.log('[OllamaManager] Ollama API is ready');
          if (onProgress) {
            onProgress('Ollama is ready');
          }
          return true;
        }
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      
      // Timeout - Ollama didn't become ready
      throw new Error('Ollama started but API did not become ready within 30 seconds');
      
    } catch (error) {
      console.error('[OllamaManager] Failed to start Ollama:', error);
      throw new Error(`Failed to start Ollama: ${(error as Error).message}`);
    }
  }

  /**
   * Check if a specific model is already pulled
   */
  async hasModel(modelName: string): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      if (!response.ok) return false;

      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models || [];
      
      // Match model name (e.g., "qwen3.5:latest" or "qwen3.5:2b")
      return models.some((m) => m.name === modelName);
    } catch {
      return false;
    }
  }

  /**
   * List all available models
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      if (!response.ok) return [];

      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models || [];
      
      return models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Pull a model with progress tracking
   * @param modelName - Model name (e.g., "qwen3.5:latest")
   * @param onProgress - Progress callback
   */
  async pullModel(
    modelName: string,
    onProgress?: (progress: ModelDownloadProgress) => void
  ): Promise<void> {
    // Check if already installed
    if (await this.hasModel(modelName)) {
      console.log(`[OllamaManager] Model ${modelName} already installed`);
      if (onProgress) {
        onProgress({ status: 'complete', percent: 100 });
      }
      return;
    }

    // Check if already downloading
    if (this.installingModels.has(modelName)) {
      console.log(`[OllamaManager] Model ${modelName} is already being downloaded`);
      return;
    }

    this.installingModels.add(modelName);
    if (onProgress) {
      this.progressCallbacks.set(modelName, onProgress);
    }

    console.log(`[OllamaManager] Pulling model: ${modelName}`);

    try {
      // Make sure Ollama is running first
      if (!(await this.isRunning())) {
        await this.start();
      }

      // Pull model using Ollama API with streaming
      const response = await fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
      });

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.statusText}`);
      }

      // Stream progress updates
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);
            
            // Calculate progress
            if (data.total && data.completed) {
              const percent = Math.round((data.completed / data.total) * 100);
              const status = data.status?.includes('pulling') ? 'downloading' : 'extracting';
              
              if (onProgress) {
                onProgress({
                  status,
                  percent,
                  total: data.total,
                  completed: data.completed,
                });
              }

              console.log(`[OllamaManager] ${modelName}: ${percent}% (${status})`);
            }

            // Check for completion
            if (data.status === 'success') {
              if (onProgress) {
                onProgress({ status: 'complete', percent: 100 });
              }
              console.log(`[OllamaManager] Successfully pulled ${modelName}`);
            }
          } catch (parseError) {
            // Ignore parse errors for partial JSON
          }
        }
      }
    } catch (error) {
      console.error(`[OllamaManager] Failed to pull model ${modelName}:`, error);
      if (onProgress) {
        onProgress({
          status: 'error',
          percent: 0,
          error: (error as Error).message,
        });
      }
      throw error;
    } finally {
      this.installingModels.delete(modelName);
      this.progressCallbacks.delete(modelName);
    }
  }

  /**
   * Ensure model is ready (auto-pulls if needed)
   */
  async ensureModel(
    modelName: string,
    onProgress?: (progress: ModelDownloadProgress) => void
  ): Promise<void> {
    // Start Ollama if not running (may download Ollama binary first time)
    if (!(await this.isRunning())) {
      console.log('[OllamaManager] Starting Ollama for model:', modelName);
      
      // Show progress for Ollama binary download (first time only)
      if (onProgress) {
        onProgress({ 
          status: 'downloading', 
          percent: 0,
        });
      }
      
      await this.start((message) => {
        // Relay Ollama installation progress to model progress callback
        console.log(`[OllamaManager] Ollama setup: ${message}`);
        if (onProgress) {
          onProgress({
            status: 'downloading',
            percent: 0, // Indeterminate progress for Ollama binary
          });
        }
      });
    }

    // Pull model if not installed
    if (!(await this.hasModel(modelName))) {
      console.log(`[OllamaManager] Model ${modelName} not found, pulling...`);
      await this.pullModel(modelName, onProgress);
    } else {
      console.log(`[OllamaManager] Model ${modelName} is ready`);
      if (onProgress) {
        onProgress({ status: 'complete', percent: 100 });
      }
    }
  }

  /**
   * Stop Ollama service
   */
  async stop(): Promise<void> {
    if (!this.ollama) return;

    try {
      // electron-ollama doesn't expose a stop method
      // Ollama will shut down when the app quits
      console.log('[OllamaManager] Ollama service will stop on app quit');
    } catch (error) {
      console.error('[OllamaManager] Failed to stop Ollama:', error);
    }
  }

  /**
   * Clean up (called on app quit)
   */
  async cleanup(): Promise<void> {
    await this.stop();
  }
}

// Singleton instance
let ollamaManagerInstance: OllamaManager | null = null;

export function getOllamaManager(): OllamaManager {
  if (!ollamaManagerInstance) {
    ollamaManagerInstance = new OllamaManager();
  }
  return ollamaManagerInstance;
}
