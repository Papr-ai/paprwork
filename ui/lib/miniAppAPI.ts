/**
 * paprAPI - Generic API for mini-apps to call Electron system APIs
 * 
 * Mini-apps run in sandboxed iframes and cannot use native browser APIs like:
 * - <a download> (blocked)
 * - window.open() (stays in iframe)
 * - navigator.clipboard (restricted)
 * 
 * Instead, mini-apps use window.paprAPI.invoke() to call whitelisted Electron APIs:
 * - shell.openExternal() - Open URLs in default apps
 * - dialog.showSaveDialog() - Save files
 * - clipboard.writeText() - Copy to clipboard
 * - notification.show() - Show OS notifications
 * - etc.
 */

export interface PaprAPI {
  /**
   * Invoke any whitelisted Electron API
   * 
   * @param method - Electron API method (e.g., 'shell.openExternal', 'dialog.showSaveDialog')
   * @param args - Arguments to pass to the method (can be multiple args or single object)
   * @returns Promise resolving to the method's return value
   * 
   * @example
   * // Open URL in default browser
   * await window.paprAPI.invoke('shell.openExternal', 'https://github.com');
   * 
   * @example
   * // Save file with dialog
   * await window.paprAPI.invoke('dialog.showSaveDialog', {
   *   defaultPath: 'export.csv',
   *   content: csvData
   * });
   * 
   * @example
   * // Copy to clipboard
   * await window.paprAPI.invoke('clipboard.writeText', 'Hello world');
   */
  invoke(method: string, ...args: any[]): Promise<any>;
}

/**
 * Create paprAPI for injection into mini-app iframe
 * 
 * This API uses postMessage to communicate with the parent window,
 * which then forwards requests to Electron via electronAPI.
 * 
 * @param appId - Mini-app ID for tracking/logging
 * @returns PaprAPI instance
 */
export function createPaprAPI(appId: string): PaprAPI {
  return {
    async invoke(method: string, ...args: any[]) {
      return new Promise((resolve, reject) => {
        const messageId = `papr-invoke-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        const handler = (event: MessageEvent) => {
          // Only process responses for this specific request
          if (event.data?.type === 'papr-invoke-response' && event.data.id === messageId) {
            window.removeEventListener('message', handler);
            
            if (event.data.error) {
              reject(new Error(event.data.error));
            } else {
              resolve(event.data.result);
            }
          }
        };
        
        window.addEventListener('message', handler);
        
        // Timeout after 10 seconds
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error(`Electron API call timed out: ${method}`));
        }, 10000);
        
        // Send request to parent window via postMessage
        window.parent.postMessage({
          type: 'papr-invoke-request',
          id: messageId,
          appId,
          method,
          args
        }, '*');
      });
    }
  };
}
