/**
 * Cloud vs desktop paprAPI.invoke methods.
 *
 * Cloud app host + gateway handle chat and vault-backed keys; other IPC
 * routes through Electron main and requires Paprwork desktop.
 */

/** Methods available on apps.papr.ai (via cloud gateway / embedded agent). */
export const CLOUD_SAFE_PAPR_API_METHODS = new Set<string>(["chat.open"]);

const PAPR_INVOKE_PATTERN =
  /(?:window\.)?paprAPI\.invoke\s*\(\s*['"`]([^'"`]+)['"`]/g;

export function extractPaprApiInvokeMethods(content: string): string[] {
  const methods = new Set<string>();
  for (const match of content.matchAll(PAPR_INVOKE_PATTERN)) {
    const method = match[1]?.trim();
    if (method) methods.add(method);
  }
  return [...methods];
}

export function getDesktopOnlyPaprApiMethods(content: string): string[] {
  return extractPaprApiInvokeMethods(content).filter(
    (method) => !CLOUD_SAFE_PAPR_API_METHODS.has(method),
  );
}

export function contentUsesDesktopOnlyPaprApi(content: string): boolean {
  return getDesktopOnlyPaprApiMethods(content).length > 0;
}
