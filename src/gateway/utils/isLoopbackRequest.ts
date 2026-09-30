import type { Request } from "express";

/** True when the TCP peer is local (Electron main, same host). */
export function isLoopbackRequest(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}
