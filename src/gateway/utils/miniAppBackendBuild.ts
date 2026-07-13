/**
 * Publish-time backend bundle — validates handlers and writes backend/bundle.json.
 */

import { createHash } from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { parseAppBackendManifest } from "../services/appRuntime/appBackendManifest.js";

export interface AppBackendBundleFile {
  handler: string;
  sha256: string;
  bytes: number;
}

export interface AppBackendBundleManifest {
  version: 1;
  builtAt: string;
  actions: Record<string, AppBackendBundleFile>;
}

export interface BuildAppBackendBundleResult {
  success: boolean;
  wroteBundle: boolean;
  errors: string[];
  bundle?: AppBackendBundleManifest;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function buildAppBackendBundle(
  appDir: string,
): Promise<BuildAppBackendBundleResult> {
  const backendDir = path.join(appDir, "backend");
  const manifestPath = path.join(backendDir, "manifest.json");

  try {
    await fs.access(manifestPath);
  } catch {
    return { success: true, wroteBundle: false, errors: [] };
  }

  const errors: string[] = [];
  let manifest;
  try {
    const raw = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as unknown;
    manifest = parseAppBackendManifest(raw);
  } catch (err) {
    return {
      success: false,
      wroteBundle: false,
      errors: [(err as Error).message],
    };
  }

  const actions: Record<string, AppBackendBundleFile> = {};
  for (const [actionName, spec] of Object.entries(manifest.actions)) {
    const handlerPath = path.join(backendDir, spec.handler);
    try {
      const content = await fs.readFile(handlerPath, "utf8");
      actions[actionName] = {
        handler: spec.handler,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content, "utf8"),
      };
    } catch {
      errors.push(
        `Action "${actionName}" references missing handler: backend/${spec.handler}`,
      );
    }
  }

  if (errors.length > 0) {
    return { success: false, wroteBundle: false, errors };
  }

  const bundle: AppBackendBundleManifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    actions,
  };

  await fs.writeFile(
    path.join(backendDir, "bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
    "utf8",
  );

  return { success: true, wroteBundle: true, errors: [], bundle };
}
