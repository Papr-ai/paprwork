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

  // People skim this page. One big instruction, one button, code last.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signed in — go back to Papr Work</title>
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
        max-width: 480px;
        background: #fff;
        border-radius: 24px;
        padding: 44px 36px 36px;
        text-align: center;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
      }
      .check {
        width: 72px;
        height: 72px;
        margin: 0 auto 22px;
        border-radius: 50%;
        background: #34c759;
        color: #fff;
        font-size: 38px;
        line-height: 72px;
        font-weight: 700;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        font-weight: 800;
        letter-spacing: -0.5px;
        line-height: 1.2;
      }
      h1 .go {
        display: block;
        margin-top: 6px;
        color: #0071e3;
      }
      .open-btn {
        display: inline-block;
        margin-top: 28px;
        padding: 15px 30px;
        border-radius: 14px;
        background: #0071e3;
        color: #fff;
        font-size: 17px;
        font-weight: 700;
        text-decoration: none;
      }
      .open-btn:hover { background: #0062c4; }
      .sub {
        margin: 14px 0 0;
        font-size: 14px;
        color: #8e8e93;
      }
      .code-section {
        margin-top: 32px;
        padding-top: 22px;
        border-top: 1px solid #e5e5ea;
      }
      .code-label {
        margin: 0 0 6px;
        font-size: 13px;
        color: #8e8e93;
      }
      .code-display {
        margin: 0;
        font-size: 30px;
        font-weight: 700;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        letter-spacing: 4px;
        color: #1c1c1e;
        user-select: all;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check" aria-hidden="true">✓</div>
      <h1>You&apos;re signed in.<span class="go">Go back to Papr Work.</span></h1>
      <a class="open-btn" href="papr://focus">Open Papr Work</a>
      <p class="sub">You can close this tab.</p>
      ${formattedCode ? `
      <div class="code-section">
        <p class="code-label">Papr Work didn&apos;t sign in? Enter this code there:</p>
        <p class="code-display" title="Click to copy">${formattedCode}</p>
      </div>
      ` : ""}
    </div>
    <script>
      ${formattedCode ? `
      document.querySelector('.code-display')?.addEventListener('click', function() {
        navigator.clipboard.writeText('${formattedCode}');
        this.style.color = '#34c759';
        setTimeout(() => { this.style.color = '#1c1c1e'; }, 1000);
      });
      ` : ""}
    </script>
  </body>
</html>`;
}

/**
 * Bring Papr Work to the front the moment the browser hands back the code,
 * so users don't have to find their way back from the browser on their own.
 */
async function bringPaprWorkToFront(): Promise<void> {
  try {
    const { app, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    } else {
      // Windows blocks focus stealing; flash the taskbar as a fallback.
      win.setAlwaysOnTop(true);
      win.focus();
      win.setAlwaysOnTop(false);
      win.flashFrame(true);
    }
    win.focus();
  } catch (err) {
    console.warn("[PaprAuthCallback] Could not focus Papr Work:", err);
  }
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
      void bringPaprWorkToFront();
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
