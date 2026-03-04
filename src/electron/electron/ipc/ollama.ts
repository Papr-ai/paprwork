/**
 * Ollama IPC Handlers - Bridge between renderer and Ollama manager
 * 
 * Exposes Ollama functionality to the UI:
 * - Check Ollama status
 * - Auto-install models
 * - Track download progress
 * - List available models
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getOllamaManager } from '../services/OllamaManager.js';

export function initializeOllamaIPC(window: BrowserWindow): void {
  const ollamaManager = getOllamaManager();

  // Check if Ollama is running
  ipcMain.handle('ollama:check-status', async () => {
    try {
      const isRunning = await ollamaManager.isRunning();
      const models = isRunning ? await ollamaManager.listModels() : [];
      
      return {
        success: true,
        isRunning,
        models,
      };
    } catch (error) {
      console.error('[Ollama IPC] Failed to check status:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // Ensure model is ready (auto-starts Ollama + pulls model if needed)
  ipcMain.handle('ollama:ensure-model', async (_event, modelName: string) => {
    try {
      console.log(`[Ollama IPC] Ensuring model: ${modelName}`);
      
      await ollamaManager.ensureModel(modelName, (progress) => {
        // Send progress updates to renderer
        window.webContents.send('ollama:download-progress', {
          modelName,
          ...progress,
        });
      });

      return { success: true };
    } catch (error) {
      console.error(`[Ollama IPC] Failed to ensure model ${modelName}:`, error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // List installed models
  ipcMain.handle('ollama:list-models', async () => {
    try {
      const models = await ollamaManager.listModels();
      return {
        success: true,
        models,
      };
    } catch (error) {
      console.error('[Ollama IPC] Failed to list models:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // Check if specific model is installed
  ipcMain.handle('ollama:has-model', async (_event, modelName: string) => {
    try {
      const hasModel = await ollamaManager.hasModel(modelName);
      return {
        success: true,
        hasModel,
      };
    } catch (error) {
      console.error(`[Ollama IPC] Failed to check model ${modelName}:`, error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // Start Ollama service
  ipcMain.handle('ollama:start', async () => {
    try {
      const started = await ollamaManager.start();
      return {
        success: true,
        started, // false if already running
      };
    } catch (error) {
      console.error('[Ollama IPC] Failed to start Ollama:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  console.log('[Ollama IPC] Handlers registered');
}
