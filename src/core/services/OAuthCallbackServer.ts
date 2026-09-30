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


const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * Browser page shown after an OAuth redirect. Same light look as the in-app
 * onboarding. `charset=utf-8` is required both in the header and the markup —
 * without it the ✓ rendered as "âœ“".
 */
function oauthResultPage(opts: { ok: boolean; title: string; body: string; autoClose?: boolean }): string {
  const mark = opts.ok ? "&#10003;" : "!";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)} · Papr Work</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f8fafd; color: #0a1020;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  .card { width: min(440px, calc(100vw - 40px)); padding: 40px 36px 34px; text-align: center;
    background: #fff; border: 1px solid #e3e9f2; border-radius: 18px;
    box-shadow: 0 12px 40px rgba(10, 16, 32, 0.06); }
  .mark { width: 54px; height: 54px; margin: 0 auto 20px; border-radius: 50%;
    display: grid; place-items: center; color: #fff; font-size: 26px; font-weight: 600;
    background: ${opts.ok ? "linear-gradient(135deg, #3b63e0, #6fc6ff)" : "#d93a3a"}; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: #5a6b85; }
  .brand { margin-top: 26px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #9aa7bb; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">${mark}</div>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${opts.body}</p>
    <div class="brand">Papr Work</div>
  </main>
  ${opts.autoClose ? "<script>setTimeout(() => window.close(), 2500);</script>" : ""}
</body>
</html>`;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

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

            res.writeHead(400, HTML_HEADERS);
            res.end(
              oauthResultPage({
                ok: false,
                title: "Sign-in didn't finish",
                body: `${escapeHtml(errorDescription || error || "Unknown error")}<br/>Close this tab and try again from Papr Work.`,
              }),
            );

            // Close server after error
            setTimeout(() => this.stop(), 1000);
            return;
          }

          // Check for authorization code
          const code = params.get("code");

          if (!code) {
            res.writeHead(400, HTML_HEADERS);
            res.end(
              oauthResultPage({
                ok: false,
                title: "Sign-in didn't finish",
                body: "No authorization code came back. Close this tab and try again from Papr Work.",
              }),
            );
            return;
          }

          // Success! Return success page
          res.writeHead(200, HTML_HEADERS);
          res.end(
            this.successHtml ??
              oauthResultPage({
                ok: true,
                title: "You're signed in",
                body: "Head back to Papr Work — it's already picked this up. You can close this tab.",
                autoClose: true,
              }),
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
