/**
 * Gateway WebSocket Client
 *
 * Connects to the Gateway server via WebSocket
 * Replaces Electron IPC communication
 */

export interface GatewayMessage {
  id: string;
  type: string;
  payload?: unknown;
}

export interface GatewayResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
  type?: string;
}

type MessageHandler = (response: GatewayResponse) => void;
type ConnectionStatusHandler = (connected: boolean) => void;

export const GATEWAY_DISCONNECTED_ERROR = "Gateway disconnected";

class GatewayClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler> = new Map();
  private connectionStatusHandlers: Set<ConnectionStatusHandler> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 30; // Increased for long sleep scenarios
  private baseReconnectDelay = 500; // Start at 500ms
  private maxReconnectDelay = 30000; // Cap at 30 seconds
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  private maxMissedHeartbeats = 3;
  /** Resolvers waiting for the first successful connection */
  private connectionWaiters: Array<() => void> = [];

  constructor() {
    // Use localhost (which resolves to 127.0.0.1) for WebSocket connections
    // Gateway listens on 0.0.0.0 to accept connections from any interface
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    this.url = `ws://${host}:${port}`;

    this.connect();
    
    // Listen for system resume events from Electron
    if (typeof window !== 'undefined') {
      window.addEventListener('system:resume', () => {
        console.log('[Gateway] System resumed - reconnecting immediately');
        this.reconnectAttempts = 0; // Reset backoff on system resume
        if (!this.isConnected()) {
          this.connect();
        }
      });
    }
  }

  /**
   * Connect to Gateway WebSocket
   */
  private connect(): void {
    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    try {
      console.log("[Gateway] Connecting to:", this.url);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("[Gateway] Connected");
        this.reconnectAttempts = 0;
        this.missedHeartbeats = 0;
        this.notifyConnectionStatus(true);
        this.startHeartbeat();
        
        // Resolve any pending waitForConnection() promises
        for (const resolve of this.connectionWaiters.splice(0)) {
          resolve();
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const response: GatewayResponse = JSON.parse(event.data);
          
          // Heartbeat response (pong)
          if (response.type === 'pong') {
            this.missedHeartbeats = 0;
            if (this.heartbeatTimeout) {
              clearTimeout(this.heartbeatTimeout);
              this.heartbeatTimeout = null;
            }
            return;
          }

          // Handle broadcast messages (no matching ID)
          if (!response.id && response.type) {
            // Dispatch as a custom event that React components can listen to
            window.dispatchEvent(
              new CustomEvent("gateway-broadcast", {
                detail: response,
              }),
            );
            return;
          }

          // Handle response
          const handler = this.handlers.get(response.id);
          if (handler) {
            handler(response);

            // Clean up handler if this is the final response
            if (response.type !== "agent:chunk") {
              this.handlers.delete(response.id);
            }
          }
        } catch (error) {
          console.error("[Gateway] Error parsing message:", error);
        }
      };

      this.ws.onerror = (error) => {
        console.error("[Gateway] WebSocket error:", error);
      };

      this.ws.onclose = () => {
        console.log("[Gateway] Disconnected");
        this.stopHeartbeat();
        this.rejectActiveStreamHandlers();
        this.notifyConnectionStatus(false);
        this.attemptReconnect();
      };
    } catch (error) {
      console.error("[Gateway] Connection error:", error);
      this.attemptReconnect();
    }
  }

  /**
   * Start heartbeat mechanism to detect dead connections
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    // Send ping every 15 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.missedHeartbeats++;
        
        if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
          console.warn('[Gateway] Too many missed heartbeats, reconnecting');
          this.ws.close();
          return;
        }
        
        // Send ping
        try {
          this.ws.send(JSON.stringify({ type: 'ping', id: 'heartbeat' }));
          
          // Expect pong within 5 seconds
          this.heartbeatTimeout = setTimeout(() => {
            if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
              console.warn('[Gateway] Heartbeat timeout, reconnecting');
              this.ws?.close();
            }
          }, 5000);
        } catch (err) {
          console.error('[Gateway] Failed to send heartbeat:', err);
        }
      }
    }, 15000);
  }

  /**
   * Stop heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    this.missedHeartbeats = 0;
  }

  /**
   * Reject in-flight stream handlers when the socket drops so callers can
   * pause UI state and re-subscribe after reconnect.
   */
  private rejectActiveStreamHandlers(): void {
    for (const [id, handler] of this.handlers) {
      try {
        handler({
          id,
          success: false,
          type: "agent:disconnect",
          error: GATEWAY_DISCONNECTED_ERROR,
        });
      } catch (error) {
        console.error("[Gateway] Error rejecting stream handler:", error);
      }
      this.handlers.delete(id);
    }
  }

  /**
   * Attempt to reconnect to Gateway with exponential backoff + jitter
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[Gateway] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (capped)
    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    
    // Add jitter: multiply by random factor between 0.5 and 1.0
    // This prevents thundering herd problem when many clients reconnect simultaneously
    const jitter = 0.5 + Math.random() * 0.5;
    const delay = Math.floor(exponentialDelay * jitter);

    console.log(
      `[Gateway] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}, base: ${exponentialDelay}ms, jitter: ${jitter.toFixed(2)})`,
    );
    
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Wait until the WebSocket connection is open.
   * Resolves immediately if already connected.
   * Times out after `timeoutMs` (default 10 s).
   */
  waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.connectionWaiters.push(resolve);
      setTimeout(() => {
        const idx = this.connectionWaiters.indexOf(resolve);
        if (idx !== -1) {
          this.connectionWaiters.splice(idx, 1);
          reject(new Error("Gateway connection timeout"));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send message to Gateway.
   * Automatically waits for connection if not yet open.
   */
  async send(
    type: string,
    payload?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<GatewayResponse> {
    // Wait up to 10 s for the WebSocket to connect
    await this.waitForConnection();

    const timeoutMs = options?.timeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Gateway not connected"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      const message: GatewayMessage = { id, type, payload };

      // Register handler
      this.handlers.set(id, (response) => {
        if (response.success) {
          resolve(response);
        } else {
          const error = new Error(response.error || "Unknown error");
          console.error(
            `[Gateway] Request failed - Type: ${type}, Error:`,
            error,
          );
          reject(error);
        }
      });

      // Send message
      this.ws.send(JSON.stringify(message));

      setTimeout(() => {
        if (this.handlers.has(id)) {
          this.handlers.delete(id);
          reject(new Error("Request timeout"));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send streaming message to Gateway.
   * Automatically waits for connection if not yet open.
   */
  async stream(
    type: string,
    payload: unknown,
    onChunk: (chunk: unknown) => void,
    onRegistered?: (requestId: string) => void,
  ): Promise<void> {
    console.log("[Gateway.stream] START", { type, payload });

    // Wait up to 10 s for the WebSocket to connect
    await this.waitForConnection();

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.error("[Gateway.stream] WebSocket not connected!");
        reject(new Error("Gateway not connected"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      console.log("[Gateway.stream] Generated ID:", id);
      const message: GatewayMessage = { id, type, payload };
      onRegistered?.(id);

      // Register handler for chunks
      this.handlers.set(id, (response) => {
        if (response.type === "agent:disconnect") {
          this.handlers.delete(id);
          reject(new Error(GATEWAY_DISCONNECTED_ERROR));
          return;
        }

        if (response.type === "agent:chunk") {
          // Handle chunk
          const payloadData =
            typeof response.data === "object" && response.data !== null
              ? { ...(response.data as Record<string, unknown>), requestId: id }
              : { payload: response.data, requestId: id };
          onChunk(payloadData);
        } else if (response.type === "agent:complete" || response.success) {
          // Stream completed successfully
          // Send final "done" chunk with finalMessage so UI can show sequence/reasoning/toolCalls
          // even when streaming chunks were missed (e.g. Codex provider)
          const completeData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          onChunk({
            type: "done",
            chatId: completeData.chatId,
            requestId: id,
            payload: {
              finalMessage: completeData.finalMessage,
            },
          });
          this.handlers.delete(id);
          resolve();
        } else if (response.type === "agent:error") {
          // Stream error
          const errorData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          onChunk({
            type: "error",
            payload: {
              error:
                typeof errorData.error === "string"
                  ? errorData.error
                  : "Stream error",
            },
            chatId: errorData.chatId,
            requestId: id,
          });
          this.handlers.delete(id);
          reject(
            new Error(
              typeof errorData.error === "string"
                ? errorData.error
                : "Stream error",
            ),
          );
        } else if (response.error) {
          // Generic error
          this.handlers.delete(id);
          reject(new Error(response.error || "Unknown error"));
        }
      });

      // Send message
      console.log("[Gateway.stream] Sending WebSocket message");
      try {
        this.ws.send(JSON.stringify(message));
        console.log("[Gateway.stream] Message sent successfully");
      } catch (err) {
        console.error("[Gateway.stream] Error sending message:", err);
        throw err;
      }

      // ⚡ NO TIMEOUT - Trust backend protection mechanisms:
      // 1. Step limit (100 tool calls) prevents infinite loops
      // 2. User can abort via UI anytime
      // 3. Backend monitors progress and can warn if needed
      // Let agents work as long as they need to complete their task!
    });
  }

  /**
   * Cancel an in-flight stream request so its Promise rejects with "aborted".
   * Used when the user stops the agent or sends a new message while streaming.
   */
  cancelRequest(requestId: string, reason = "aborted"): void {
    const handler = this.handlers.get(requestId);
    if (!handler) return;

    handler({
      id: requestId,
      type: "agent:error",
      success: false,
      error: reason,
      data: { error: reason },
    });
    this.handlers.delete(requestId);
  }

  /**
   * Re-attach to an in-flight agent stream after reconnect.
   * Replays buffered chunks and continues receiving live updates.
   */
  async subscribeStream(
    chatId: string,
    streamRequestId: string,
    fromChunkIndex: number,
    onChunk: (chunk: unknown) => void,
    onRegistered?: (subscribeRequestId: string) => void,
  ): Promise<void> {
    await this.waitForConnection();

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Gateway not connected"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      onRegistered?.(id);

      this.handlers.set(id, (response) => {
        if (response.type === "agent:disconnect") {
          this.handlers.delete(id);
          reject(new Error(GATEWAY_DISCONNECTED_ERROR));
          return;
        }

        if (response.type === "agent:chunk") {
          const payloadData =
            typeof response.data === "object" && response.data !== null
              ? {
                  ...(response.data as Record<string, unknown>),
                  requestId: streamRequestId,
                }
              : { payload: response.data, requestId: streamRequestId };
          onChunk(payloadData);
          return;
        }

        if (response.type === "agent:complete" || response.success) {
          const completeData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          onChunk({
            type: "done",
            chatId: completeData.chatId,
            requestId: streamRequestId,
            payload: {
              finalMessage: completeData.finalMessage,
            },
          });
          this.handlers.delete(id);
          resolve();
          return;
        }

        if (response.type === "agent:error") {
          const errorData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          onChunk({
            type: "error",
            payload: {
              error:
                typeof errorData.error === "string"
                  ? errorData.error
                  : "Stream error",
            },
            chatId: errorData.chatId,
            requestId: streamRequestId,
          });
          this.handlers.delete(id);
          reject(
            new Error(
              typeof errorData.error === "string"
                ? errorData.error
                : "Stream error",
            ),
          );
          return;
        }

        if (response.error) {
          this.handlers.delete(id);
          reject(new Error(response.error || "Unknown error"));
        }
      });

      this.ws.send(
        JSON.stringify({
          id,
          type: "agent:subscribe",
          payload: {
            chatId,
            requestId: streamRequestId,
            fromChunkIndex,
          },
        }),
      );
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection state for UI indicator
   */
  getConnectionState(): 'connected' | 'reconnecting' | 'disconnected' {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return 'connected';
    } else if (this.reconnectAttempts > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
      return 'reconnecting';
    } else {
      return 'disconnected';
    }
  }

  /**
   * Subscribe to connection status changes
   * Returns unsubscribe function
   */
  onConnectionChange(handler: ConnectionStatusHandler): () => void {
    this.connectionStatusHandlers.add(handler);
    // Immediately notify current status
    handler(this.isConnected());
    // Return unsubscribe function
    return () => {
      this.connectionStatusHandlers.delete(handler);
    };
  }

  /**
   * Notify all connection status handlers
   */
  private notifyConnectionStatus(connected: boolean): void {
    this.connectionStatusHandlers.forEach((handler) => {
      try {
        handler(connected);
      } catch (error) {
        console.error("[Gateway] Error in connection status handler:", error);
      }
    });
  }
}

// Export singleton instance
export const gateway = new GatewayClient();
