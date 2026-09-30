import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AppBackendService } from "../src/gateway/services/appRuntime/AppBackendService.js";
import {
  DEFAULT_BACKEND_MANIFEST,
  DEFAULT_BACKEND_PING_HANDLER,
  DEFAULT_BACKEND_PING_HANDLER_JS,
  DEFAULT_BACKEND_PING_HANDLER_TS,
} from "../src/gateway/utils/appBackendScaffold.js";

describe("AppBackendService (local)", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("app-backend-local");

  let tempRoot: string;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs scaffolded ping action", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-"));
    const appId = "test-app-id";
    const backendDir = join(tempRoot, "apps", appId, "backend");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(DEFAULT_BACKEND_MANIFEST, null, 2),
    );
    await writeFile(join(backendDir, "ping.py"), DEFAULT_BACKEND_PING_HANDLER);

    const service = new AppBackendService(tempRoot);
    const result = await service.runAction({
      appId,
      action: "ping",
      params: { hello: "world" },
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      action: string;
      params: { hello: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("ping");
    expect(payload.params.hello).toBe("world");
  });

  it("runs node ping action", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-"));
    const appId = "test-app-node";
    const backendDir = join(tempRoot, "apps", appId, "backend");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          actions: {
            ping: {
              handler: "ping.mjs",
              runtime: "node",
              timeoutMs: 10_000,
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(backendDir, "ping.mjs"), DEFAULT_BACKEND_PING_HANDLER_JS);

    const service = new AppBackendService(tempRoot);
    const result = await service.runAction({
      appId,
      action: "ping",
      params: { mode: "node" },
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      params: { mode: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.params.mode).toBe("node");
  });

  it("runs typescript ping action when esbuild is available", async () => {
    let esbuildAvailable = false;
    try {
      const esbuild = await import("esbuild");
      await esbuild.transform("const x = 1", {
        loader: "ts",
        platform: "node",
        format: "esm",
      });
      esbuildAvailable = true;
    } catch {
      esbuildAvailable = false;
    }
    if (!esbuildAvailable) {
      return;
    }

    tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-"));
    const appId = "test-app-ts";
    const backendDir = join(tempRoot, "apps", appId, "backend");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          actions: {
            ping: {
              handler: "ping.ts",
              runtime: "typescript",
              timeoutMs: 10_000,
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(backendDir, "ping.ts"), DEFAULT_BACKEND_PING_HANDLER_TS);

    const service = new AppBackendService(tempRoot);
    const result = await service.runAction({
      appId,
      action: "ping",
      params: { mode: "ts" },
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      params: { mode: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.params.mode).toBe("ts");
  });

  it("injects APP_DB when data-sources.json links primary sqlite", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-"));
    const appId = "test-app-db";
    const dbPath = join(tempRoot, "linked.db");
    await writeFile(dbPath, "sqlite-placeholder");

    const backendDir = join(tempRoot, "apps", appId, "backend");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      join(tempRoot, "apps", appId, "data-sources.json"),
      JSON.stringify(
        {
          primary: "main",
          sources: [
            {
              id: "j:main",
              type: "sqlite",
              jobId: "33333333-3333-3333-3333-333333333333",
              alias: "main",
              role: "primary",
              dbPath,
              tables: [],
              linkedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          actions: {
            ping: { handler: "ping.py", runtime: "python", timeoutMs: 10_000 },
          },
        },
        null,
        2,
      ),
    );
    const pingDbHandler = `#!/usr/bin/env python3
import json, os, sys
json.dump({"dbMode": os.environ.get("PAPR_DB_MODE"), "appDb": os.environ.get("APP_DB")}, sys.stdout)
`;
    await writeFile(join(backendDir, "ping.py"), pingDbHandler);

    const service = new AppBackendService(tempRoot);
    const result = await service.runAction({ appId, action: "ping" });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      dbMode: string;
      appDb: string;
    };
    expect(payload.dbMode).toBe("local");
    expect(payload.appDb).toBe(dbPath);
  });

  it("injects PAPR_DB_* for multiple linked sources with manifest sourceId", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "papr-backend-"));
    const appId = "test-app-multi-db";
    const metricsPath = join(tempRoot, "metrics.db");
    const billingPath = join(tempRoot, "billing.db");
    await writeFile(metricsPath, "sqlite-placeholder");
    await writeFile(billingPath, "sqlite-placeholder");

    const backendDir = join(tempRoot, "apps", appId, "backend");
    await mkdir(backendDir, { recursive: true });
    await writeFile(
      join(tempRoot, "apps", appId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "db-a:metrics",
              type: "sqlite",
              dbId: "db-aaaa1111",
              alias: "metrics",
              dbPath: metricsPath,
              tables: [],
              linkedAt: new Date().toISOString(),
            },
            {
              id: "db-b:billing",
              type: "sqlite",
              dbId: "db-bbbb2222",
              alias: "billing",
              dbPath: billingPath,
              tables: [],
              linkedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(backendDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          actions: {
            readBilling: {
              handler: "read_billing.py",
              runtime: "python",
              sourceId: "billing",
              timeoutMs: 10_000,
            },
          },
        },
        null,
        2,
      ),
    );
    const handler = `#!/usr/bin/env python3
import json, os, sys
json.dump({
  "appDb": os.environ.get("APP_DB"),
  "billing": os.environ.get("PAPR_DB_BILLING"),
  "metrics": os.environ.get("PAPR_DB_METRICS"),
  "active": os.environ.get("PAPR_ACTIVE_SOURCE_ID"),
}, sys.stdout)
`;
    await writeFile(join(backendDir, "read_billing.py"), handler);

    const service = new AppBackendService(tempRoot);
    const result = await service.runAction({ appId, action: "readBilling" });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      appDb: string;
      billing: string;
      metrics: string;
      active: string;
    };
    expect(payload.appDb).toBe(billingPath);
    expect(payload.billing).toBe(billingPath);
    expect(payload.metrics).toBe(metricsPath);
    expect(payload.active).toBe("billing");
  });
});

import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";