/**
 * App-level API key requirements (git-synced requirements.json).
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import {
  normalizeCredentialRequirements,
  type CredentialScope,
} from "../../core/utils/credentialScope.js";
import {
  RequiredKeySpecSchema,
  type RequiredKeySpec,
  type KeyClientAccessSpec,
  type ServiceCategory,
} from "../../core/types/bundles.js";
import {
  collectBackendManifestKeyNames,
  parseAppBackendManifest,
} from "./appRuntime/appBackendManifest.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";
import { extractCustomKeyNames } from "../utils/keySubstitution.js";

export const CLOUD_APP_REQUIREMENTS_FILENAME = "requirements.json";

export interface CloudAppRequirementsFile {
  schemaVersion: "1.0.0";
  requirements: RequiredKeySpec[];
  updatedAt: string;
}

function requirementsPath(paprDir: string, appId: string): string {
  return path.join(paprDir, "apps", appId, CLOUD_APP_REQUIREMENTS_FILENAME);
}

export function readAppRequirements(
  paprDir: string,
  appId: string,
): RequiredKeySpec[] {
  const filePath = requirementsPath(paprDir, appId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CloudAppRequirementsFile;
    if (!Array.isArray(parsed.requirements)) {
      return [];
    }
    return normalizeCredentialRequirements(
      parsed.requirements.map((item) => RequiredKeySpecSchema.parse(item)),
    );
  } catch {
    return [];
  }
}

export function writeAppRequirements(
  paprDir: string,
  appId: string,
  requirements: RequiredKeySpec[],
): CloudAppRequirementsFile {
  const normalized = normalizeCredentialRequirements(
    requirements.map((item) => RequiredKeySpecSchema.parse(item)),
  );
  const payload: CloudAppRequirementsFile = {
    schemaVersion: "1.0.0",
    requirements: normalized,
    updatedAt: new Date().toISOString(),
  };
  const filePath = requirementsPath(paprDir, appId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function parseRequirementsFileContent(
  content: string,
): RequiredKeySpec[] {
  try {
    const parsed = JSON.parse(content) as CloudAppRequirementsFile;
    if (!Array.isArray(parsed.requirements)) {
      return [];
    }
    return normalizeCredentialRequirements(
      parsed.requirements.map((item) => RequiredKeySpecSchema.parse(item)),
    );
  } catch {
    return [];
  }
}

export function catalogRequirementsForPublish(
  requirements: RequiredKeySpec[],
): Array<{
  name: string;
  service: string;
  category: string;
  description: string;
  required: boolean;
  credentialScope: CredentialScope;
  clientAccess?: KeyClientAccessSpec;
  signupUrl?: string;
  docsUrl?: string;
}> {
  return normalizeCredentialRequirements(requirements).map((spec) => ({
    name: spec.name,
    service: spec.service,
    category: spec.category,
    description: spec.description,
    required: spec.required !== false,
    credentialScope: spec.credentialScope ?? "user",
    clientAccess: spec.clientAccess ?? "server",
    ...(spec.signupUrl ? { signupUrl: spec.signupUrl } : {}),
    ...(spec.docsUrl ? { docsUrl: spec.docsUrl } : {}),
  }));
}

function inferServiceLabelFromKeyName(keyName: string): string {
  const base = keyName.replace(/_API_KEY$/i, "").replace(/_/g, " ").trim();
  if (!base) {
    return keyName;
  }
  return base
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferCategoryFromKeyName(keyName: string): ServiceCategory {
  const upper = keyName.toUpperCase();
  if (upper.includes("DB") || upper.includes("DATABASE") || upper.includes("NEON")) {
    return "database";
  }
  if (upper.includes("STRIPE") || upper.includes("PAYMENT")) {
    return "payments";
  }
  if (upper.includes("OPENAI") || upper.includes("ANTHROPIC") || upper.includes("GEMINI")) {
    return "ai";
  }
  return "other";
}

/** Merge backend/manifest.json action keys into app requirements (cloud catalog). */
export function mergeBackendKeysIntoRequirements(
  requirements: RequiredKeySpec[],
  backendKeyNames: readonly string[],
): RequiredKeySpec[] {
  const byName = new Map(
    normalizeCredentialRequirements(requirements).map((spec) => [spec.name, spec]),
  );
  for (const name of backendKeyNames) {
    const trimmed = name.trim();
    if (!trimmed || byName.has(trimmed)) {
      continue;
    }
    byName.set(trimmed, {
      name: trimmed,
      service: inferServiceLabelFromKeyName(trimmed),
      category: inferCategoryFromKeyName(trimmed),
      description:
        "Server-side key for app backend handlers (synced from backend/manifest.json)",
      required: true,
      credentialScope: "owner",
      clientAccess: "server",
    });
  }
  return normalizeCredentialRequirements([...byName.values()]);
}

export async function readBackendManifestKeyNames(
  paprDir: string,
  appId: string,
): Promise<string[]> {
  const manifestPath = path.join(
    paprDir,
    "apps",
    appId,
    "backend",
    "manifest.json",
  );
  try {
    const raw = JSON.parse(
      await fsPromises.readFile(manifestPath, "utf8"),
    ) as unknown;
    const manifest = parseAppBackendManifest(raw);
    return collectBackendManifestKeyNames(manifest);
  } catch {
    return [];
  }
}

function readJobCommand(paprDir: string, jobId: string): string | null {
  const jobJsonPath = path.join(paprDir, "Jobs", jobId, "job.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(jobJsonPath, "utf8")) as {
      command?: string;
    };
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}

/** ${KEY_NAME} placeholders from jobs linked to this app (data-sources, appIds, deps). */
export function readLinkedJobKeyNames(
  paprDir: string,
  appId: string,
): string[] {
  const names = new Set<string>();
  for (const jobId of resolveAppDependentJobIds(paprDir, appId)) {
    const command = readJobCommand(paprDir, jobId);
    if (!command) {
      continue;
    }
    for (const name of extractCustomKeyNames(command)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** requirements.json merged with backend/manifest.json keys (cloud catalog source of truth). */
export async function readEffectiveAppRequirements(
  paprDir: string,
  appId: string,
): Promise<RequiredKeySpec[]> {
  const fromFile = readAppRequirements(paprDir, appId);
  const backendKeys = await readBackendManifestKeyNames(paprDir, appId);
  const jobKeys = readLinkedJobKeyNames(paprDir, appId);
  return mergeBackendKeysIntoRequirements(
    mergeBackendKeysIntoRequirements(fromFile, backendKeys),
    jobKeys,
  );
}

export interface AppRequirementsDiscovery {
  requirements: RequiredKeySpec[];
  savedRequirements: RequiredKeySpec[];
  detectedKeyNames: string[];
}

/** Effective catalog plus which keys were auto-detected (not yet in requirements.json). */
export async function discoverAppRequirements(
  paprDir: string,
  appId: string,
): Promise<AppRequirementsDiscovery> {
  const savedRequirements = readAppRequirements(paprDir, appId);
  const requirements = await readEffectiveAppRequirements(paprDir, appId);
  const savedNames = new Set(savedRequirements.map((spec) => spec.name));
  const detectedKeyNames = requirements
    .map((spec) => spec.name)
    .filter((name) => !savedNames.has(name));
  return { requirements, savedRequirements, detectedKeyNames };
}

/**
 * Persist requirements.json when backend manifest declares keys missing from the catalog.
 * Cloud vault-resolve only returns keys registered in the published catalog.
 */
export async function ensureAppRequirementsSyncedWithBackend(
  paprDir: string,
  appId: string,
): Promise<{ updated: boolean; requirements: RequiredKeySpec[] }> {
  const existing = readAppRequirements(paprDir, appId);
  const backendKeys = await readBackendManifestKeyNames(paprDir, appId);
  const jobKeys = readLinkedJobKeyNames(paprDir, appId);
  const merged = mergeBackendKeysIntoRequirements(
    mergeBackendKeysIntoRequirements(existing, backendKeys),
    jobKeys,
  );
  const existingNames = new Set(existing.map((spec) => spec.name));
  const added = merged.filter((spec) => !existingNames.has(spec.name));
  if (added.length === 0) {
    return { updated: false, requirements: merged };
  }
  writeAppRequirements(paprDir, appId, merged);
  console.log(
    `[CloudRequirements] Synced detected keys to requirements.json for ${appId}: ${added.map((spec) => spec.name).join(", ")}`,
  );
  return { updated: true, requirements: merged };
}
