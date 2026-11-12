/**
 * Get updates skips backend/bundle.json and .papr-cloud-revision (platform-written),
 * and the post-pull rebuild only covers dist/ and db.ts. Once memory#477 started
 * refreshing both on main after an accepted proposal, a pull that brought a new
 * handler left this machine with the old bundle: two phantom "unpublished changes".
 *
 * Fix: after the pull, if the web's bundle.json describes exactly the handlers now
 * on disk, adopt the web's bundle.json and revision marker byte for byte (nothing
 * left to publish). If the handlers differ (a real local edit), leave both alone:
 * the next publish rebuilds them and that change is real.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseAppBackendManifest } from "../appRuntime/appBackendManifest.js";

const BUNDLE = "backend/bundle.json";
const REVISION = ".papr-cloud-revision";

type Actions = Record<string, { handler: string; sha256: string; bytes: number }>;

async function localActions(appDir: string): Promise<Actions | null> {
  try {
    const manifest = parseAppBackendManifest(
      JSON.parse(await fs.readFile(path.join(appDir, "backend", "manifest.json"), "utf8")) as unknown,
    );
    const actions: Actions = {};
    for (const [name, spec] of Object.entries(manifest.actions)) {
      const content = await fs.readFile(path.join(appDir, "backend", spec.handler), "utf8");
      actions[name] = {
        handler: spec.handler,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        bytes: Buffer.byteLength(content, "utf8"),
      };
    }
    return actions;
  } catch {
    return null;
  }
}

/** Same handlers, same hashes, regardless of key order or builtAt. */
function sameActions(a: Actions, b: Actions): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("\0") !== kb.join("\0")) return false;
  return ka.every((k) => a[k].handler === b[k].handler && a[k].sha256 === b[k].sha256);
}

/** Returns the platform files it brought in line with the web (empty when nothing to do). */
export async function adoptPulledBackendBundle(
  appDir: string,
  upstreamFiles: ReadonlyMap<string, string>,
  /** The cloned web copy: the revision marker is a dotfile, so it isn't in upstreamFiles. */
  sourceDir: string,
): Promise<string[]> {
  const remoteBundle = upstreamFiles.get(BUNDLE);
  if (remoteBundle === undefined) return [];
  let remoteActions: Actions;
  try {
    remoteActions = (JSON.parse(remoteBundle) as { actions?: Actions }).actions ?? {};
  } catch {
    return [];
  }
  const local = await localActions(appDir);
  if (!local || !sameActions(local, remoteActions)) return [];

  const adopted: string[] = [];
  const write = async (rel: string, content: string) => {
    const full = path.join(appDir, rel);
    const current = await fs.readFile(full, "utf8").catch(() => null);
    if (current === content) return;
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    adopted.push(rel);
  };
  await write(BUNDLE, remoteBundle);
  const remoteRevision = await fs.readFile(path.join(sourceDir, REVISION), "utf8").catch(() => undefined);
  if (remoteRevision !== undefined) await write(REVISION, remoteRevision);
  return adopted;
}
