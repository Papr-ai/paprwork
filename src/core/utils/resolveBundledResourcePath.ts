/**
 * Cloud Agent Gateway ships compiled output under dist/ only (no src/ tree).
 * Agents and prompts reference bundled docs as src/resources/... — remap for read_file.
 */

import path from "path";
import { fileURLToPath } from "url";
import { isCloudAgentGatewayMode } from "./paprRoot.js";

/** Matches .../src/resources/<rest> on any platform. */
const SRC_RESOURCES_SUFFIX = /[/\\]src[/\\]resources[/\\](.+)$/i;

let bundledResourcesRoot: string | undefined;

/** dist/resources beside compiled gateway core (mirrors SkillService layout). */
export function getGatewayBundledResourcesRoot(): string {
  if (!bundledResourcesRoot) {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    bundledResourcesRoot = path.resolve(thisDir, "../../resources");
  }
  return bundledResourcesRoot;
}

/**
 * In cloud_agent mode, map agent-doc paths from src/resources → bundled dist/resources.
 * Desktop/dev keeps src/resources on disk and passes through unchanged.
 */
export function resolveBundledResourceReadPath(resolvedPath: string): string {
  if (!isCloudAgentGatewayMode()) {
    return resolvedPath;
  }

  const match = resolvedPath.match(SRC_RESOURCES_SUFFIX);
  if (!match?.[1]) {
    return resolvedPath;
  }

  const suffixParts = match[1].split(/[/\\]/).filter(Boolean);
  return path.join(getGatewayBundledResourcesRoot(), ...suffixParts);
}
