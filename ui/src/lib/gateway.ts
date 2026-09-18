/**
 * Gateway WebSocket Client
 *
 * Connects to the Gateway server via WebSocket
 * Replaces Electron IPC communication
 */

import { isExpectedStreamCancellation } from "../../../src/core/constants/streamCancellation.js";
import {
  getUiStreamProfiler,
  isUiStreamProfilingEnabled,
} from "../../lib/streamProfiler";
import {
  resolveGatewayConnectionState,
  type GatewayConnectionState,
} from "../../utils/gatewayConnectionState";
import { scheduleSuspendAwareTimeout } from "../../utils/suspendAwareDeadline";

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

export type { GatewayConnectionState };

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_ACTIVE_STREAM_MS = 20_000;
const MAX_MISSED_HEARTBEATS_DEFAULT = 3;
const MAX_MISSED_HEARTBEATS_ACTIVE_STREAM = 12;
const PONG_WAIT_MS = 8_000;
const DEGRADED_AFTER_MISSED = 2;

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
  private activeAgentStreams = 0;
  private connectionDegraded = false;
  /**
   * Whether a socket has ever opened this session. Distinguishes a reconnect
   * from the initial connect, which the backoff counter cannot do once it has
   * been reset (see resolveGatewayConnectionState).
   */
  private hasEverConnected = false;
  /** Epoch ms of the last `system:resume`, read by suspend-aware deadlines. */
  private lastResumeAtMs = 0;
  /** Resolvers waiting for the first successful connection */
  private connectionWaiters: Array<() => void> = [];
  /** Resolvers waiting on a one-shot liveness probe (see probeConnection) */
  private pongWaiters = new Set<() => void>();

  constructor() {
    // Use localhost (which resolves to 127.0.0.1) for WebSocket connections
    // Gateway listens on 0.0.0.0 to accept connections from any interface
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    this.url = `ws://${host}:${port}`;

    this.connect();

    // Listen for system resume events from Electron
    if (typeof window !== "undefined") {
      window.addEventListener("system:resume", () => {
        this.lastResumeAtMs = Date.now();
        // Reset backoff: a long sleep should not leave us waiting out a 30s
        // delay. The connection state no longer reads "am I reconnecting" off
        // this counter, so zeroing it cannot mislabel the indicator.
        this.reconnectAttempts = 0;

        if (this.ws?.readyState === WebSocket.OPEN) {
          // `isConnected()` cannot detect the one condition a resume
          // guarantees: a socket whose peer vanished while both ends were
          // frozen still reports OPEN — that is what half-open means. So the
          // old `if (!this.isConnected())` did nothing here, and detection fell
          // to the heartbeat, which while a stream is active tolerates 12
          // missed beats at 20s each (240s).
          //
          // Probe instead. No pong closes the socket, which runs the existing
          // onclose path (reject in-flight handlers → reconnect → resume
          // tracked streams) rather than adding a second recovery mechanism.
          console.log("[Gateway] System resumed — probing socket liveness");
          void this.probeConnection();
          return;
        }

        console.log("[Gateway] System resumed - reconnecting immediately");
        this.connect();
      });
    }
  }

  /**
   * After OS sleep the WebSocket often stays OPEN while the TCP session is dead
   * ("zombie"). Heartbeats can take 45s+ to notice; force a fresh socket on wake.
   */
  private reconnectAfterSystemWake(source: "resume"): void {
    console.log(
      `[Gateway] System ${source} — forcing WebSocket reconnect (stale OPEN sockets are common after sleep)`,
    );
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.teardownWebSocketForWake();
    this.rejectActiveStreamHandlers();
    this.notifyConnectionStatus(false);
    this.connect();
  }

  /** Close the current socket without triggering exponential backoff reconnect. */
  private teardownWebSocketForWake(): void {
    const sock = this.ws;
    if (!sock) {
      return;
    }
    sock.onclose = () => {};
    sock.onerror = () => {};
    try {
      if (
        sock.readyState === WebSocket.OPEN ||
        sock.readyState === WebSocket.CONNECTING
      ) {
        sock.close(4000, "system wake");
      }
    } catch {
      // ignore
    }
    this.ws = null;
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
        this.hasEverConnected = true;
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
            this.setConnectionDegraded(false);
            if (this.heartbeatTimeout) {
              clearTimeout(this.heartbeatTimeout);
              this.heartbeatTimeout = null;
            }
            for (const resolve of [...this.pongWaiters]) {
              resolve();
            }
            this.pongWaiters.clear();
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
        this.activeAgentStreams = 0;
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

  private maxMissedHeartbeats(): number {
    return this.activeAgentStreams > 0
      ? MAX_MISSED_HEARTBEATS_ACTIVE_STREAM
      : MAX_MISSED_HEARTBEATS_DEFAULT;
  }

  private heartbeatIntervalMs(): number {
    return this.activeAgentStreams > 0
      ? HEARTBEAT_INTERVAL_ACTIVE_STREAM_MS
      : HEARTBEAT_INTERVAL_MS;
  }

  private beginAgentStreamActivity(): void {
    this.activeAgentStreams += 1;
    this.restartHeartbeat();
  }

  private endAgentStreamActivity(): void {
    this.activeAgentStreams = Math.max(0, this.activeAgentStreams - 1);
    this.restartHeartbeat();
  }

  private restartHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.startHeartbeat();
    }
  }

  private setConnectionDegraded(degraded: boolean): void {
    if (this.connectionDegraded === degraded) {
      return;
    }
    this.connectionDegraded = degraded;
    this.notifyConnectionStatus(this.isConnected());
  }

  /**
   * Start heartbeat mechanism to detect dead connections
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = this.heartbeatIntervalMs();

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.missedHeartbeats++;

        const maxMissed = this.maxMissedHeartbeats();
        if (
          this.missedHeartbeats >= DEGRADED_AFTER_MISSED &&
          this.activeAgentStreams > 0 &&
          this.missedHeartbeats < maxMissed
        ) {
          this.setConnectionDegraded(true);
        }

        if (this.missedHeartbeats >= maxMissed) {
          console.warn(
            `[Gateway] Too many missed heartbeats (${this.missedHeartbeats}/${maxMissed}, ` +
              `activeStreams=${this.activeAgentStreams}), reconnecting`,
          );
          this.ws.close();
          return;
        }

        try {
          this.ws.send(JSON.stringify({ type: 'ping', id: 'heartbeat' }));

          this.heartbeatTimeout = setTimeout(() => {
            if (this.missedHeartbeats >= this.maxMissedHeartbeats()) {
              console.warn('[Gateway] Heartbeat timeout, reconnecting');
              this.ws?.close();
            }
          }, PONG_WAIT_MS);
        } catch (err) {
          console.error('[Gateway] Failed to send heartbeat:', err);
        }
      }
    }, intervalMs);
  }

  /**
   * One-shot liveness probe, for callers that have their own reason to suspect
   * the socket is dead before the heartbeat would say so.
   *
   * The heartbeat is deliberately lax while a stream is active (12 missed beats
   * × 20s = 240s) so a heavy turn is never interrupted. That is the right
   * trade-off for the heartbeat, which cannot tell a slow turn from a dead
   * socket — but a caller that already knows a turn has delivered *nothing*
   * has evidence the heartbeat does not, and should not have to wait out that
   * budget.
   *
   * Resolves true if a pong arrives in time. Otherwise closes the socket, which
   * runs the existing `onclose` path (reject in-flight handlers → reconnect →
   * resume tracked streams) rather than adding a second recovery mechanism.
   */
  async probeConnection(timeoutMs = PONG_WAIT_MS): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ type: "ping", id: "heartbeat" }));
    } catch (err) {
      console.warn("[Gateway] Liveness probe could not send — closing:", err);
      this.ws.close();
      return false;
    }

    const alive = await new Promise<boolean>((resolve) => {
      const onPong = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.pongWaiters.delete(onPong);
        resolve(false);
      }, timeoutMs);
      this.pongWaiters.add(onPong);
    });

    if (!alive) {
      console.warn(
        `[Gateway] Liveness probe got no pong in ${timeoutMs}ms — closing socket to force reconnect`,
      );
      this.ws?.close();
    }
    return alive;
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
    this.setConnectionDegraded(false);
    // A probe in flight when the socket closes will never see a pong; let it
    // fall through to its own timeout rather than resolving it as alive.
    this.pongWaiters.clear();
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
   * Times out after `timeoutMs` (default 30 s — Gateway needs ~12-15s in dev).
   */
  waitForConnection(timeoutMs = 30_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.connectionWaiters.push(resolve);
      // Suspend-aware: this deadline is the one users hit on wake, because the
      // frozen renderer fires it overdue the instant the lid opens.
      scheduleSuspendAwareTimeout({
        delayMs: timeoutMs,
        getLastResumeAtMs: () => this.lastResumeAtMs,
        onRearm: ({ attempt, elapsedMs }) =>
          console.warn(
            `[Gateway] waitForConnection deadline spanned a suspend ` +
              `(${Math.round(elapsedMs / 1000)}s elapsed for a ${timeoutMs}ms budget) — ` +
              `re-arming (${attempt}/2) instead of reporting a timeout`,
          ),
        onExpire: () => {
          const idx = this.connectionWaiters.indexOf(resolve);
          if (idx !== -1) {
            this.connectionWaiters.splice(idx, 1);
            reject(new Error("Gateway connection timeout"));
          }
        },
      });
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
    // Wait for the WebSocket to connect (default 30s — Gateway needs ~12-15s in dev)
    await this.waitForConnection(options?.timeoutMs ?? 30_000);

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
          // A handler that sets success: false without an error string used to
          // surface as a bare "Unknown error" with no way to tell which
          // request failed. Include the message type and any response data.
          const error = new Error(
            response.error ||
              `Request "${type}" failed without an error message` +
                (response.data
                  ? ` (data: ${JSON.stringify(response.data).slice(0, 200)})`
                  : ""),
          );
          console.error(
            `[Gateway] Request failed - Type: ${type}, Error:`,
            error,
          );
          reject(error);
        }
      });

      // Send message
      this.ws.send(JSON.stringify(message));

      scheduleSuspendAwareTimeout({
        delayMs: timeoutMs,
        getLastResumeAtMs: () => this.lastResumeAtMs,
        onRearm: ({ attempt, elapsedMs }) =>
          console.warn(
            `[Gateway] Request "${type}" deadline spanned a suspend ` +
              `(${Math.round(elapsedMs / 1000)}s elapsed for a ${timeoutMs}ms budget) — ` +
              `re-arming (${attempt}/2) instead of reporting a timeout`,
          ),
        onExpire: () => {
          if (this.handlers.has(id)) {
            this.handlers.delete(id);
            reject(new Error("Request timeout"));
          }
        },
      });
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

    // Wait for the WebSocket to connect (default 30s — Gateway needs ~12-15s in dev)
    await this.waitForConnection();

    this.beginAgentStreamActivity();

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
      let receivedDoneChunk = false;

      // Register handler for chunks
      this.handlers.set(id, (response) => {
        if (response.type === "agent:disconnect") {
          this.handlers.delete(id);
          this.endAgentStreamActivity();
          reject(new Error(GATEWAY_DISCONNECTED_ERROR));
          return;
        }

        if (response.type === "agent:chunk") {
          // Handle chunk
          const payloadData =
            typeof response.data === "object" && response.data !== null
              ? { ...(response.data as Record<string, unknown>), requestId: id }
              : { payload: response.data, requestId: id };
          if (isUiStreamProfilingEnabled()) {
            const chunkType =
              typeof payloadData === "object" &&
              payloadData !== null &&
              typeof (payloadData as { type?: unknown }).type === "string"
                ? (payloadData as { type: string }).type
                : "unknown";
            const chunkChatId =
              typeof payloadData === "object" &&
              payloadData !== null &&
              typeof (payloadData as { chatId?: unknown }).chatId === "string"
                ? (payloadData as { chatId: string }).chatId
                : undefined;
            if (chunkChatId) {
              getUiStreamProfiler(chunkChatId)?.mark(
                `ui.ws.agentChunk.${chunkType}`,
              );
            }
          }
          if (
            typeof payloadData === "object" &&
            payloadData !== null &&
            (payloadData as { type?: string }).type === "done" &&
            typeof (payloadData as { chatId?: unknown }).chatId === "string" &&
            ((payloadData as { chatId: string }).chatId.length > 0)
          ) {
            receivedDoneChunk = true;
          }
          onChunk(payloadData);
        } else if (response.type === "agent:complete" || response.success) {
          // Stream completed successfully
          const completeData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          if (!receivedDoneChunk) {
            // Codex / missed chunks — synthesize done from persisted message
            onChunk({
              type: "done",
              chatId: completeData.chatId,
              requestId: id,
              payload: {
                finalMessage: completeData.finalMessage,
              },
            });
          }
          this.handlers.delete(id);
          this.endAgentStreamActivity();
          resolve();
        } else if (response.type === "agent:cancelled") {
          this.handlers.delete(id);
          this.endAgentStreamActivity();
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
          this.endAgentStreamActivity();
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
          this.endAgentStreamActivity();
          reject(new Error(response.error || "Unknown error"));
        }
      });

      // Send message
      console.log("[Gateway.stream] Sending WebSocket message");
      try {
        this.ws.send(JSON.stringify(message));
        console.log("[Gateway.stream] Message sent successfully");
      } catch (err) {
        this.endAgentStreamActivity();
        console.error("[Gateway.stream] Error sending message:", err);
        throw err;
      }

      // ⚡ NO TIMEOUT - Trust backend protection mechanisms:
      // 1. Step limit (100 tool calls) prevents infinite loops
      // 2. User can abort via UI anytime
      // 3. Backend monitors progress and can warn if needed
      // Let agents work as long as they need to complete their task!
    }).catch((error) => {
      this.endAgentStreamActivity();
      throw error;
    });
  }

  /**
   * Cancel an in-flight stream request without surfacing an error for intentional stops.
   */
  cancelRequest(requestId: string, reason = "aborted"): void {
    const handler = this.handlers.get(requestId);
    if (!handler) return;

    if (isExpectedStreamCancellation(reason)) {
      this.handlers.delete(requestId);
      handler({
        id: requestId,
        type: "agent:cancelled",
        success: true,
      });
      return;
    }

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

    this.beginAgentStreamActivity();

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Gateway not connected"));
        return;
      }

      const id = Math.random().toString(36).substring(2, 15);
      onRegistered?.(id);
      let receivedDoneChunk = false;

      this.handlers.set(id, (response) => {
        if (response.type === "agent:disconnect") {
          this.handlers.delete(id);
          this.endAgentStreamActivity();
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
          if (
            typeof payloadData === "object" &&
            payloadData !== null &&
            (payloadData as { type?: string }).type === "done" &&
            typeof (payloadData as { chatId?: unknown }).chatId === "string" &&
            ((payloadData as { chatId: string }).chatId.length > 0)
          ) {
            receivedDoneChunk = true;
          }
          onChunk(payloadData);
          return;
        }

        if (response.type === "agent:complete" || response.success) {
          const completeData =
            typeof response.data === "object" && response.data !== null
              ? (response.data as Record<string, unknown>)
              : {};
          if (!receivedDoneChunk) {
            onChunk({
              type: "done",
              chatId: completeData.chatId,
              requestId: streamRequestId,
              payload: {
                finalMessage: completeData.finalMessage,
              },
            });
          }
          this.handlers.delete(id);
          this.endAgentStreamActivity();
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
          this.endAgentStreamActivity();
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
          this.endAgentStreamActivity();
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
    }).catch((error) => {
      this.endAgentStreamActivity();
      throw error;
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
  getConnectionState(): GatewayConnectionState {
    return resolveGatewayConnectionState({
      readyState: this.ws?.readyState ?? null,
      degraded: this.connectionDegraded,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      hasEverConnected: this.hasEverConnected,
    });
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
