/** HTTP base URL for the local Gateway (REST routes like /api/app-agent/*). */
export function getGatewayHttpBase(): string {
  if (import.meta.env.DEV) {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}`;
  }
  return "http://localhost:18789";
}
