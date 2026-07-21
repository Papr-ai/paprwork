/**
 * Server-Sent Events for published app revision changes (post-sync reload).
 */

import type { Express, Request, Response } from "express";
import type { AppRevisionHub } from "./AppRevisionHub.js";

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function registerAppRevisionSseRoutes(
  app: Express,
  hub: AppRevisionHub,
): void {
  app.get(
    "/:namespaceId/:slug/__papr__/app-revision/events",
    (req: Request, res: Response) => {
      const namespaceId = req.params.namespaceId;
      const slug = req.params.slug;
      if (!namespaceId || !slug) {
        res.status(400).send("namespaceId and slug are required");
        return;
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      res.write(": connected\n\n");

      const unsubscribe = hub.subscribe((event) => {
        if (event.namespaceId !== namespaceId || event.slug !== slug) {
          return;
        }
        writeSse(res, "app-revision", { revision: event.revision });
      });

      const keepAlive = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 25_000);

      req.on("close", () => {
        unsubscribe();
        clearInterval(keepAlive);
      });
    },
  );
}
