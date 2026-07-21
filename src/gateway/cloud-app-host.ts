/**
 * Standalone Cloud App Host entry point.
 *
 * Deploy to Cloud Run as apps.papr.ai. Requires:
 * - PAPR_CLOUD_APP_HOST_KEY (shared secret with memory server)
 * - PAPR_MEMORY_SERVER_URL (default https://memory.papr.ai)
 * - AUTH0_DOMAIN / AUTH0_CLIENT_ID (same Papr Auth0 tenant as desktop)
 * - Register callback URL: https://apps.papr.ai/auth/callback
 *
 * Multi-tenant: Turso + GitHub access goes through memory runtime APIs using
 * publish ACL (namespace/slug + session cookie or share token cookie).
 */

import dotenv from "dotenv";
import { resolve } from "path";
import express from "express";
import {
  CloudAppHostService,
  MemoryServerPublishResolver,
  MemoryServerTursoCredentials,
} from "./services/appRuntime/CloudAppHostService.js";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });

const PORT = Number(process.env.PORT ?? process.env.CLOUD_APP_HOST_PORT ?? 8787);

async function main(): Promise<void> {
  if (!process.env.PAPR_CLOUD_APP_HOST_KEY) {
    console.error(
      "[CloudAppHost] PAPR_CLOUD_APP_HOST_KEY is required (must match memory server)",
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.set("trust proxy", 1);

  const host = new CloudAppHostService({
    tursoCredentials: new MemoryServerTursoCredentials(),
    publishResolver: new MemoryServerPublishResolver(),
  });
  host.registerRoutes(app);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CloudAppHost] Listening on :${PORT}`);
    console.log(
      `[CloudAppHost] Memory server: ${process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"}`,
    );
  });
}

main().catch((err) => {
  console.error("[CloudAppHost] Fatal:", err);
  process.exit(1);
});
