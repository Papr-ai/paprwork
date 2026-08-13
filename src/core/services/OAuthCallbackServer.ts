/**
 * OAuth Callback Server - Temporary HTTP server for OAuth callbacks
 * Handles OAuth redirect callbacks for OpenAI and Claude
 *
 * Features:
 * - Dynamic port selection (tries multiple ports if primary is busy)
 * - Automatic timeout and cleanup
 * - Custom success/error pages
 */

import http from "http";
import net from "net";
import { URL } from "url";

export interface CallbackServerOptions {
  port: number;
  timeout?: number; // Auto-close after this many ms (default: 60000)
  callbackPath?: string; // Path to listen on (default: "/auth/callback")
  hostname?: string; // Hostname to bind to (default: "127.0.0.1")
  successHtml?: string; // Custom success page HTML
  onCallback?: (params: URLSearchParams) => void;
  maxPortAttempts?: number; // Number of ports to try (default: 10)
}

/**
 * Check if a port is available for binding
 */
async function isPortAvailable(
  port: number,
  hostname: string = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, hostname);
  });
}

/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(
  startPort: number,
  hostname: string = "127.0.0.1",
  maxAttempts: number = 10,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port, hostname)) {
      return port;
    }
    console.log(`[OAuthCallback] Port ${port} is busy, trying next...`);
  }
  throw new Error(
    `No available ports found in range ${startPort}-${startPort + maxAttempts - 1}`,
  );
}

export class OAuthCallbackServer {
  private server: http.Server | null = null;
  private requestedPort: number;
  private actualPort: number | null = null;
  private timeout: number;
  private callbackPath: string;
  private hostname: string;
  private successHtml?: string;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private onCallback?: (params: URLSearchParams) => void;
  private maxPortAttempts: number;

  constructor(options: CallbackServerOptions) {
    this.requestedPort = options.port;
    this.timeout = options.timeout || 60000; // 1 minute default
    this.callbackPath = options.callbackPath || "/auth/callback";
    this.hostname = options.hostname || "127.0.0.1";
    this.successHtml = options.successHtml;
    this.onCallback = options.onCallback;
    this.maxPortAttempts = options.maxPortAttempts || 10;
  }

  /**
   * Get the actual port the server is running on (may differ from requested if that was busy)
   */
  getPort(): number | null {
    return this.actualPort;
  }

  /**
   * Get the full callback URL
   */
  getCallbackUrl(): string | null {
    if (!this.actualPort) return null;
    return `http://${this.hostname}:${this.actualPort}${this.callbackPath}`;
  }

  /**
   * Start the callback server with dynamic port selection
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Callback server already running");
    }

    // Find an available port (dynamic port selection)
    try {
      this.actualPort = await findAvailablePort(
        this.requestedPort,
        this.hostname,
        this.maxPortAttempts,
      );
      if (this.actualPort !== this.requestedPort) {
        console.log(
          `[OAuthCallback] Primary port ${this.requestedPort} busy, using ${this.actualPort}`,
        );
      }
    } catch (portError) {
      throw new Error(
        `Failed to find available port: ${portError instanceof Error ? portError.message : String(portError)}`,
      );
    }

    const port = this.actualPort;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try {
          // Only handle callback path
          if (!req.url || !req.url.startsWith(this.callbackPath)) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          // Parse query parameters
          const url = new URL(req.url, `http://localhost:${port}`);
          const params = url.searchParams;

          // Check for error
          if (params.has("error")) {
            const error = params.get("error");
            const errorDescription =
              params.get("error_description") || "Unknown error";

            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head>
                  <title>Authentication Error</title>
                  <style>
                    body {
                      font-family: system-ui, -apple-system, sans-serif;
                      max-width: 600px;
                      margin: 100px auto;
                      padding: 20px;
                      text-align: center;
                    }
                    .error {
                      color: #d32f2f;
                      font-size: 18px;
                      margin: 20px 0;
                    }
                  </style>
                </head>
                <body>
                  <h1>Authentication Failed</h1>
                  <div class="error">${error}: ${errorDescription}</div>
                  <p>You can close this window and try again.</p>
                </body>
              </html>
            `);

            // Close server after error
            setTimeout(() => this.stop(), 1000);
            return;
          }

          // Check for authorization code
          const code = params.get("code");

          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head>
                  <title>Authentication Error</title>
                  <style>
                    body {
                      font-family: system-ui, -apple-system, sans-serif;
                      max-width: 600px;
                      margin: 100px auto;
                      padding: 20px;
                      text-align: center;
                    }
                  </style>
                </head>
                <body>
                  <h1>Authentication Error</h1>
                  <p>No authorization code received.</p>
                  <p>You can close this window and try again.</p>
                </body>
              </html>
            `);
            return;
          }

          // Success! Return success page
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            this.successHtml ??
              `<!DOCTYPE html>
            <html>
              <head>
                <title>Authentication Successful</title>
                <style>
                  body {
                    font-family: system-ui, -apple-system, sans-serif;
                    max-width: 600px;
                    margin: 100px auto;
                    padding: 20px;
                    text-align: center;
                  }
                  .success {
                    color: #2e7d32;
                    font-size: 24px;
                    margin: 20px 0;
                  }
                </style>
              </head>
              <body>
                <h1>Authentication Successful!</h1>
                <div class="success">✓ You can now close this window</div>
                <p>Return to Papr Work to continue.</p>
                <script>
                  setTimeout(() => {
                    window.close();
                  }, 2000);
                </script>
              </body>
            </html>`,
          );

          // Call callback handler
          if (this.onCallback) {
            this.onCallback(params);
          }

          // Close server after successful callback
          setTimeout(() => this.stop(), 1000);
        } catch (error) {
          console.error("[OAuthCallback] Error handling request:", error);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });

      this.server.on("error", (error) => {
        console.error("[OAuthCallback] Server error:", error);
        reject(error);
      });

      this.server.listen(port, this.hostname, () => {
        console.log(
          `[OAuthCallback] Listening on http://${this.hostname}:${port}${this.callbackPath}`,
        );

        // Set timeout to auto-close
        this.timeoutHandle = setTimeout(() => {
          console.log("[OAuthCallback] Timeout reached, closing server");
          this.stop();
        }, this.timeout);

        resolve();
      });
    });
  }

  /**
   * Stop the callback server
   */
  stop(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    if (this.server) {
      this.server.close(() => {
        console.log("[OAuthCallback] Server closed");
      });
      this.server = null;
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }
}
