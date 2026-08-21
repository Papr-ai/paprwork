/**
 * Localhost OAuth callback for Papr desktop login.
 * Shows a branded success page in the browser instead of leaving users on Auth0.
 */

import { OAuthCallbackServer } from "../../core/services/OAuthCallbackServer.js";

export const PAPR_AUTH_CALLBACK_PORT = 18791;

export function getPaprAuthLocalRedirectUri(): string {
  return `http://127.0.0.1:${PAPR_AUTH_CALLBACK_PORT}/auth/callback`;
}

/**
 * Generate a verification code for manual entry fallback.
 * The code is stored in memory and can be verified by the desktop app.
 */
const verificationCodes = new Map<string, { createdAt: number; sessionData: unknown }>();
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function generateVerificationCode(): string {
  // Generate 6 alphanumeric chars (uppercase)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Removed confusing chars: I, O, 0, 1
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function formatVerificationCode(code: string): string {
  // Format as XXX-XXX for readability
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function storeVerificationCode(code: string, sessionData: unknown): void {
  // Clean up expired codes
  const now = Date.now();
  for (const [storedCode, data] of verificationCodes) {
    if (now - data.createdAt > CODE_TTL_MS) {
      verificationCodes.delete(storedCode);
    }
  }
  
  verificationCodes.set(code, { createdAt: now, sessionData });
  console.log(`[PaprAuthCallback] Stored verification code: ${formatVerificationCode(code)}`);
}

export function verifyCode(code: string): { valid: boolean; sessionData?: unknown } {
  const normalizedCode = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const data = verificationCodes.get(normalizedCode);
  
  if (!data) {
    return { valid: false };
  }
  
  // Check if expired
  if (Date.now() - data.createdAt > CODE_TTL_MS) {
    verificationCodes.delete(normalizedCode);
    return { valid: false };
  }
  
  // Code is valid - remove it (single use)
  verificationCodes.delete(normalizedCode);
  console.log(`[PaprAuthCallback] Verification code used: ${formatVerificationCode(normalizedCode)}`);
  return { valid: true, sessionData: data.sessionData };
}

export function buildPaprAuthSuccessHtml(verificationCode?: string): string {
  const formattedCode = verificationCode ? formatVerificationCode(verificationCode) : null;
  
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
      .code-section {
        margin-top: 28px;
        padding-top: 24px;
        border-top: 1px solid #e5e5ea;
      }
      .code-label {
        font-size: 13px;
        color: #8e8e93;
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .code-display {
        font-size: 32px;
        font-weight: 700;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        letter-spacing: 4px;
        color: #0080FF;
        margin: 0 0 12px;
        user-select: all;
        cursor: pointer;
      }
      .code-hint {
        font-size: 13px;
        color: #8e8e93;
        margin: 0;
        line-height: 1.4;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check" aria-hidden="true">✓</div>
      <h1>You&apos;re signed in</h1>
      <p>Go back to Papr Work on your computer. We&apos;ll connect your account automatically.</p>
      <p class="hint">You can close this browser tab once Papr Work shows you&apos;re signed in.</p>
      ${formattedCode ? `
      <div class="code-section">
        <p class="code-label">If Papr Work still doesn&apos;t show you as signed in, enter this code there:</p>
        <p class="code-display" title="Click to copy">${formattedCode}</p>
        <p class="code-hint">Enter this code in Papr Work to finish signing in.</p>
      </div>
      ` : ""}
    </div>
    <script>
      ${formattedCode ? `
      // Copy code on click
      document.querySelector('.code-display')?.addEventListener('click', function() {
        navigator.clipboard.writeText('${formattedCode}');
        this.style.color = '#34c759';
        setTimeout(() => { this.style.color = '#0080FF'; }, 1000);
      });
      ` : ""}
      setTimeout(function () { window.close(); }, 5000);
    </script>
  </body>
</html>`;
}

let activeServer: OAuthCallbackServer | null = null;

export function stopPaprAuthCallbackServer(): void {
  activeServer?.stop();
  activeServer = null;
}

/**
 * Get the actual port the callback server is running on.
 * Returns null if server is not running.
 */
export function getPaprAuthCallbackServerPort(): number | null {
  return activeServer?.getPort() ?? null;
}

/** Current verification code for the active auth session */
let currentVerificationCode: string | null = null;

export function getCurrentVerificationCode(): string | null {
  return currentVerificationCode;
}

export async function startPaprAuthCallbackServer(
  onCallback: (params: URLSearchParams, verificationCode: string) => void | Promise<void>,
): Promise<string> {
  stopPaprAuthCallbackServer();

  // Generate a verification code for this session
  currentVerificationCode = generateVerificationCode();
  const successHtml = buildPaprAuthSuccessHtml(currentVerificationCode);

  const server = new OAuthCallbackServer({
    port: PAPR_AUTH_CALLBACK_PORT,
    timeout: 5 * 60 * 1000,
    successHtml,
    maxPortAttempts: 10, // Try ports 18791-18800
    onCallback: (params) => {
      const code = currentVerificationCode!;
      void Promise.resolve(onCallback(params, code)).finally(() => {
        stopPaprAuthCallbackServer();
      });
    },
  });

  await server.start();
  activeServer = server;

  // Return the actual callback URL (may use different port if primary was busy)
  const actualUrl = server.getCallbackUrl();
  if (!actualUrl) {
    throw new Error("Server started but callback URL not available");
  }

  console.log(`[PaprAuthCallback] Server ready at: ${actualUrl}`);
  console.log(`[PaprAuthCallback] Verification code: ${formatVerificationCode(currentVerificationCode)}`);
  return actualUrl;
}
