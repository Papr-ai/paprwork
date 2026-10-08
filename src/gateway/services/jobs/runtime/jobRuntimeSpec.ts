import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * What a job declares it needs, read from its own folder so it travels with the
 * job (synced, forked, installed from the catalog) with no extra registry.
 *
 *   requirements.txt  python packages (existing convention; create_job writes it)
 *   runtime.json      { "python": [...], "node": [...], "tools": ["ffmpeg"] }
 *
 * Both sources are merged; runtime.json is the one place that can also declare
 * node packages and system tools.
 */
export interface JobRuntimeSpec {
  pythonPackages: string[];
  nodePackages: string[];
  tools: string[];
}

export const RUNTIME_MANIFEST_FILENAME = "runtime.json";

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function readRequirementsTxt(jobDir: string): string[] {
  const file = path.join(jobDir, "requirements.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

export function readJobRuntimeSpec(jobDir: string): JobRuntimeSpec {
  let manifest: Record<string, unknown> = {};
  const manifestPath = path.join(jobDir, RUNTIME_MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      // A malformed manifest must not brick the job; treat as empty.
      manifest = {};
    }
  }
  return {
    pythonPackages: uniq([
      ...readRequirementsTxt(jobDir),
      ...cleanList(manifest.python),
    ]),
    nodePackages: uniq(cleanList(manifest.node)),
    tools: uniq(cleanList(manifest.tools)),
  };
}

export function specIsEmpty(spec: JobRuntimeSpec): boolean {
  return (
    spec.pythonPackages.length === 0 &&
    spec.nodePackages.length === 0 &&
    spec.tools.length === 0
  );
}

/** Stable content hash: two jobs declaring the same node packages share one install. */
export function nodeRuntimeKey(packages: string[]): string {
  const sorted = [...packages].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}
