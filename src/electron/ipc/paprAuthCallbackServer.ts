/**
 * Localhost OAuth callback for Papr desktop login.
 * Shows a branded success page in the browser instead of leaving users on Auth0.
 */

import { OAuthCallbackServer } from "../../core/services/OAuthCallbackServer.js";

export const PAPR_AUTH_CALLBACK_PORT = 18791;

export function getPaprAuthLocalRedirectUri(): string {
  return `http://127.0.0.1:${PAPR_AUTH_CALLBACK_PORT}/auth/callback`;
}

export function buildPaprAuthSuccessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signed in to Papr Work</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 100%);
        color: #1c1c1e;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: #fff;
        border-radius: 20px;
        padding: 40px 32px;
        text-align: center;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
      }
      .check {
        width: 64px;
        height: 64px;
        margin: 0 auto 20px;
        border-radius: 50%;
        background: #34c759;
        color: #fff;
        font-size: 32px;
        line-height: 64px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
        font-weight: 700;
      }
      p {
        margin: 0;
        color: #636366;
        font-size: 16px;
        line-height: 1.5;
      }
      .hint {
        margin-top: 20px;
        font-size: 14px;
        color: #8e8e93;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check" aria-hidden="true">✓</div>
      <h1>You&apos;re signed in</h1>
      <p>Return to Papr Work — your app will open automatically.</p>
      <p class="hint">You can close this browser tab.</p>
    </div>
    <script>
      setTimeout(function () { window.close(); }, 2500);
    </script>
  </body>
</html>`;
}

let activeServer: OAuthCallbackServer | null = null;

export function stopPaprAuthCallbackServer(): void {
  activeServer?.stop();
  activeServer = null;
}

export async function startPaprAuthCallbackServer(
  onCallback: (params: URLSearchParams) => void | Promise<void>,
): Promise<string> {
  stopPaprAuthCallbackServer();

  const successHtml = buildPaprAuthSuccessHtml();
  const server = new OAuthCallbackServer({
    port: PAPR_AUTH_CALLBACK_PORT,
    timeout: 5 * 60 * 1000,
    successHtml,
    onCallback: (params) => {
      void Promise.resolve(onCallback(params)).finally(() => {
        stopPaprAuthCallbackServer();
      });
    },
  });

  await server.start();
  activeServer = server;
  return getPaprAuthLocalRedirectUri();
}
