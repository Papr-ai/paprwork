/** Lets /health and WebSocket heartbeats run between heavy sync steps. */
export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
