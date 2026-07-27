/** True when an API key belongs to the given org + namespace pair. */
export function paprApiKeyMatchesNamespace(
  apiKey: string,
  organizationId: string,
  namespaceId: string,
): boolean {
  const prefix = `sk-org-${organizationId}-namespace-${namespaceId}-`;
  return apiKey.startsWith(prefix);
}
