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

class GatewayClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler> = new Map();
  private connectionStatusHandlers: Set<ConnectionStatusHandler> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private url: string;
  /** Resolvers waiting for the first successful connection */
  private connectionWaiters: Array<() => void> = [];

  constructor() {
    // Use localhost (which resolves to 127.0.0.1) for WebSocket connections
    // Gateway listens on 0.0.0.0 to accept connections from any interface
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    this.url = `ws://${host}:${port}`;

    this.connect();
  }

  /**
   * Connect to Gateway WebSocket
   */
  private connect(): void {
    try {
      console.log("[Gateway] Connecting to:", this.url);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("[Gateway] Connected");
        this.reconnectAttempts = 0;
        this.notifyConnectionStatus(true);
        // Resolve any pending waitForConnection() promises
        for (const resolve of this.connectionWaiters.splice(0)) {
          resolve();
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const response: GatewayResponse = JSON.parse(event.data);

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
        this.notifyConnectionStatus(false);
        this.attemptReconnect();
      };
    } catch (error) {
      console.error("[Gateway] Connection error:", error);
      this.attemptReconnect();
    }
  }

  /**
   * Attempt to reconnect to Gateway
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[Gateway] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    console.log(
      `[Gateway] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => this.connect(), delay);
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
  async send(type: string, payload?: unknown): Promise<GatewayResponse> {
    // Wait up to 10 s for the WebSocket to connect
    await this.waitForConnection();

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

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.handlers.has(id)) {
          this.handlers.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
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
        if (response.type === "agent:chunk") {
          // Handle chunk
          const payloadData =
            typeof response.data === "object" && response.data !== null
              ? { ...(response.data as Record<string, unknown>), requestId: id }
              : { payload: response.data, requestId: id };
          onChunk(payloadData);
        } else if (response.type === "agent:complete" || response.success) {
          // Stream completed successfully
          // Send final "done" chunk to UI
          const completeData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          onChunk({
            type: "done",
            chatId: completeData.chatId,
            requestId: id,
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
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
