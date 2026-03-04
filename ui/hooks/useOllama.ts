/**
 * useOllama - React hook for managing Ollama local AI models
 * 
 * Features:
 * - Auto-detects Ollama status
 * - Auto-installs models when selected
 * - Shows download progress
 * - Seamless user experience
 */

import { useState, useEffect, useCallback } from 'react';

interface OllamaStatus {
  isRunning: boolean;
  installedModels: string[];
  checking: boolean;
}

interface ModelInstallProgress {
  modelName: string;
  status: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  error?: string;
}

export function useOllama() {
  const [status, setStatus] = useState<OllamaStatus>({
    isRunning: false,
    installedModels: [],
    checking: true,
  });
  
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<ModelInstallProgress | null>(null);

  // Check Ollama status on mount
  const checkStatus = useCallback(async () => {
    if (!window.electronAPI?.ollama) return;

    try {
      const result = await window.electronAPI.ollama.checkStatus();
      if (result.success) {
        setStatus({
          isRunning: result.isRunning || false,
          installedModels: result.models || [],
          checking: false,
        });
      }
    } catch (error) {
      console.error('[useOllama] Failed to check status:', error);
      setStatus(prev => ({ ...prev, checking: false }));
    }
  }, []);

  useEffect(() => {
    checkStatus();

    // Listen for download progress
    const handleProgress = (data: ModelInstallProgress) => {
      setProgress(data);
      
      if (data.status === 'complete') {
        // Model installed successfully
        setInstalling(null);
        setProgress(null);
        // Refresh model list
        checkStatus();
      } else if (data.status === 'error') {
        console.error('[useOllama] Model install error:', data.error);
        setInstalling(null);
      }
    };

    if (window.electronAPI?.ollama) {
      window.electronAPI.ollama.onDownloadProgress(handleProgress);
    }

    return () => {
      if (window.electronAPI?.ollama) {
        window.electronAPI.ollama.removeDownloadProgressListener(handleProgress);
      }
    };
  }, [checkStatus]);

  /**
   * Ensure model is ready (auto-installs if needed)
   * Call this when user selects a Qwen model
   */
  const ensureModel = useCallback(async (modelName: string): Promise<boolean> => {
    if (!window.electronAPI?.ollama) {
      console.warn('[useOllama] Ollama API not available');
      return false;
    }

    // Check if already installed
    if (status.installedModels.includes(modelName)) {
      console.log(`[useOllama] Model ${modelName} already installed`);
      return true;
    }

    // Start installation
    setInstalling(modelName);
    setProgress({
      modelName,
      status: 'downloading',
      percent: 0,
    });

    try {
      const result = await window.electronAPI.ollama.ensureModel(modelName);
      
      if (result.success) {
        console.log(`[useOllama] Model ${modelName} ready`);
        return true;
      } else {
        console.error(`[useOllama] Failed to ensure model:`, result.error);
        setInstalling(null);
        setProgress(null);
        return false;
      }
    } catch (error) {
      console.error('[useOllama] ensureModel error:', error);
      setInstalling(null);
      setProgress(null);
      return false;
    }
  }, [status.installedModels]);

  /**
   * Check if a specific model is installed
   */
  const hasModel = useCallback((modelName: string): boolean => {
    return status.installedModels.includes(modelName);
  }, [status.installedModels]);

  /**
   * Get user-friendly status message
   */
  const getStatusMessage = useCallback((): string => {
    if (status.checking) {
      return 'Checking Ollama status...';
    }
    
    if (!status.isRunning) {
      return 'Ollama will auto-start when you select a model';
    }

    if (status.installedModels.length === 0) {
      return 'No models installed yet';
    }

    return `${status.installedModels.length} model(s) installed`;
  }, [status]);

  return {
    status,
    installing,
    progress,
    ensureModel,
    hasModel,
    checkStatus,
    getStatusMessage,
    isReady: status.isRunning || !status.checking,
  };
}
