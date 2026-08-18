/** Clean pasted Claude OAuth token text (handles spaces, line breaks, ANSI codes). */
export function cleanClaudeOAuthToken(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

export function isValidClaudeOAuthToken(token: string): boolean {
  return token.startsWith("sk-ant-oat") && token.length > 80;
}

/** Short preview for UI: sk-ant-oat01-abc…xyz */
export function previewClaudeOAuthToken(token: string): string {
  if (token.length <= 28) return token;
  return `${token.slice(0, 18)}…${token.slice(-6)}`;
}
