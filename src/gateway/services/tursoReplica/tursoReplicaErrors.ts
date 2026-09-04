/**
 * Error classifiers shared by the gateway and the sync worker. No native imports here.
 */

export function isTursoHostNotReadyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("404") ||
    msg.includes("Host not found") ||
    msg.includes("not found")
  );
}
