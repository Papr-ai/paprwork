/**
 * OAuth Callback Server - Temporary HTTP server for OAuth callbacks
 * Handles OAuth redirect callbacks for OpenAI and Claude
 */

import http from "http";
import { URL } from "url";

export interface CallbackServerOptions {
  port: number;
  timeout?: number; // Auto-close after this many ms (default: 60000)
  callbackPath?: string; // Path to listen on (default: "/auth/callback")
  hostname?: string; // Hostname to bind to (default: "127.0.0.1")
  successHtml?: string; // Custom success page HTML
  onCallback?: (params: URLSearchParams) => void;
}

export class OAuthCallbackServer {
  private server: http.Server | null = null;
  private port: number;
  private timeout: number;
  private callbackPath: string;
  private hostname: string;
  private successHtml?: string;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private onCallback?: (params: URLSearchParams) => void;

  constructor(options: CallbackServerOptions) {
    this.port = options.port;
    this.timeout = options.timeout || 60000; // 1 minute default
    this.callbackPath = options.callbackPath || "/auth/callback";
    this.hostname = options.hostname || "127.0.0.1";
    this.successHtml = options.successHtml;
    this.onCallback = options.onCallback;
  }

  /**
   * Start the callback server
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Callback server already running");
    }

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
          const url = new URL(req.url, `http://localhost:${this.port}`);
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

      this.server.listen(this.port, this.hostname, () => {
        console.log(
          `[OAuthCallback] Listening on http://${this.hostname}:${this.port}${this.callbackPath}`,
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
