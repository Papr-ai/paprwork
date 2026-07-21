export function isTransientGatewayError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Gateway not connected") ||
    message.includes("Gateway connection timeout") ||
    message.includes("Request timeout") ||
    message.includes("Gateway disconnected")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
