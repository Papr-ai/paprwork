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
  normalizeRequirements,
  RequiredKeySpecSchema,
  RequirementItemSchema,
  SERVICE_CATEGORIES,
  type RequirementItem,
  type RequiredKeySpec,
  type KeyClientAccessSpec,
  type ServiceCategory,
} from "../../core/types/bundles.js";
import {
  collectBackendManifestKeyNames,
  parseAppBackendManifest,
} from "./appRuntime/appBackendManifest.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";
import { filterVaultKeyNames, isPlatformInjectedEnvKey } from "../../core/utils/platformInjectedEnvKeys.js";
import { extractCustomKeyNames } from "../utils/keySubstitution.js";
import {
  AUTO_DETECTED_KEY_DESCRIPTION,
  AppKeysUndeclaredError,
  findUndeclaredKeys,
  looksLikeCredentialName,
  type DetectedKeyRef,
  type UndeclaredKey,
} from "./appKeyDeclarations.js";
import type { AppAgentChatConfig } from "../../core/types/appAgentChat.js";
import type { Provider } from "../../core/types/agents.js";
import type { SubAgentProfile } from "../../core/types/subagents.js";
import {
  collectLlmEnvKeysForProviders,
  mergeAgentChatLlmKeysIntoRequirements,
} from "../../core/utils/agentChatLlmRequirements.js";

export const CLOUD_APP_REQUIREMENTS_FILENAME = "requirements.json";

export interface CloudAppRequirementsFile {
  schemaVersion: "1.0.0";
  requirements: RequiredKeySpec[];
  /**
   * Names found in code that are NOT keys (job parameters like ${TASK}).
   * Declared by the agent or publisher so the publish check stops asking.
   */
  notKeys?: string[];
  updatedAt: string;
}

function requirementsPath(paprDir: string, appId: string): string {
  return path.join(paprDir, "apps", appId, CLOUD_APP_REQUIREMENTS_FILENAME);
}

function isServiceCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORIES as readonly string[]).includes(value);
}

/** Tolerate agent-written requirements.json (name-only objects, bare strings). */
export function parseRequirementItemsLoose(raw: unknown[]): RequiredKeySpec[] {
  const items: RequirementItem[] = [];
  for (const item of raw) {
    const direct = RequirementItemSchema.safeParse(item);
    if (direct.success) {
      items.push(direct.data);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }
    const service =
      typeof record.service === "string" && record.service.trim()
        ? record.service.trim()
        : inferServiceLabelFromKeyName(name);
    const categoryRaw =
      typeof record.category === "string"
        ? record.category
        : inferCategoryFromKeyName(name);
    const category: ServiceCategory = isServiceCategory(categoryRaw)
      ? categoryRaw
      : inferCategoryFromKeyName(name);
    const coerced = {
      name,
      service,
      category,
      description: typeof record.description === "string" ? record.description : "",
      required: record.required !== false,
      credentialScope: record.credentialScope === "owner" ? ("owner" as const) : ("user" as const),
      clientAccess: record.clientAccess === "client" ? ("client" as const) : ("server" as const),
      ...(typeof record.signupUrl === "string" ? { signupUrl: record.signupUrl } : {}),
      ...(typeof record.docsUrl === "string" ? { docsUrl: record.docsUrl } : {}),
    };
    const specTry = RequiredKeySpecSchema.safeParse(coerced);
    items.push(specTry.success ? specTry.data : name);
  }
  return normalizeCredentialRequirements(normalizeRequirements(items));
}

function requirementsFromFileJson(raw: string, appId: string): RequiredKeySpec[] {
  try {
    const parsed = JSON.parse(raw) as CloudAppRequirementsFile;
    if (!Array.isArray(parsed.requirements)) {
      return [];
    }
    return stripPlatformInjectedRequirements(
      parseRequirementItemsLoose(parsed.requirements),
    );
  } catch (error) {
    console.warn(
      `[CloudRequirements] Failed to read ${CLOUD_APP_REQUIREMENTS_FILENAME} for ${appId}:`,
      (error as Error).message,
    );
    return [];
  }
}

export function readAppRequirements(
  paprDir: string,
  appId: string,
): RequiredKeySpec[] {
  const filePath = requirementsPath(paprDir, appId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return requirementsFromFileJson(raw, appId);
  } catch {
    return [];
  }
}

function stripPlatformInjectedRequirements(
  requirements: RequiredKeySpec[],
): RequiredKeySpec[] {
  return requirements.filter((spec) => !isPlatformInjectedEnvKey(spec.name));
}

/** Names declared as not-a-key (job parameters) in requirements.json. */
export function readAppNotKeys(paprDir: string, appId: string): string[] {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(requirementsPath(paprDir, appId), "utf8"),
    ) as { notKeys?: unknown };
    return Array.isArray(parsed.notKeys)
      ? parsed.notKeys
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function writeAppRequirements(
  paprDir: string,
  appId: string,
  requirements: RequiredKeySpec[],
  options?: { notKeys?: readonly string[] },
): CloudAppRequirementsFile {
  const normalized = stripPlatformInjectedRequirements(
    normalizeCredentialRequirements(
      requirements.map((item) => RequiredKeySpecSchema.parse(item)),
    ),
  );
  const declaredNames = new Set(normalized.map((spec) => spec.name));
  const notKeys = [
    ...new Set(
      (options?.notKeys ?? readAppNotKeys(paprDir, appId))
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !declaredNames.has(name)),
    ),
  ].sort();
  const payload: CloudAppRequirementsFile = {
    schemaVersion: "1.0.0",
    requirements: normalized,
    ...(notKeys.length > 0 ? { notKeys } : {}),
    updatedAt: new Date().toISOString(),
  };
  const filePath = requirementsPath(paprDir, appId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

/**
 * Add or replace declared key rows (by name) without touching the others.
 * Names in `notKeys` are removed from requirements and remembered as parameters.
 */
export function upsertDeclaredAppKeys(
  paprDir: string,
  appId: string,
  specs: RequiredKeySpec[],
  notKeys: readonly string[] = [],
): CloudAppRequirementsFile {
  const notKeySet = new Set(notKeys.map((name) => name.trim()).filter(Boolean));
  const byName = new Map(
    readAppRequirements(paprDir, appId).map((spec) => [spec.name, spec]),
  );
  for (const spec of specs) {
    byName.set(spec.name, spec);
    notKeySet.delete(spec.name);
  }
  for (const name of notKeySet) {
    byName.delete(name);
  }
  const keptNotKeys = readAppNotKeys(paprDir, appId).filter(
    (name) => !specs.some((spec) => spec.name === name),
  );
  return writeAppRequirements(paprDir, appId, [...byName.values()], {
    notKeys: [...keptNotKeys, ...notKeySet],
  });
}

export function parseRequirementsFileContent(
  content: string,
): RequiredKeySpec[] {
  return requirementsFromFileJson(content, "(inline)");
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

/**
 * Draft rows for detected key names (owner scope, placeholder description).
 * Display only: the Share → API keys panel shows them so the publisher can
 * decide. Never written to requirements.json on its own, and a row that still
 * has the placeholder description counts as undeclared at publish.
 */
export function mergeBackendKeysIntoRequirements(
  requirements: RequiredKeySpec[],
  backendKeyNames: readonly string[],
): RequiredKeySpec[] {
  const byName = new Map(
    normalizeCredentialRequirements(requirements).map((spec) => [spec.name, spec]),
  );
  for (const name of filterVaultKeyNames(backendKeyNames)) {
    const trimmed = name.trim();
    if (!trimmed || byName.has(trimmed)) {
      continue;
    }
    byName.set(trimmed, {
      name: trimmed,
      service: inferServiceLabelFromKeyName(trimmed),
      category: inferCategoryFromKeyName(trimmed),
      description: AUTO_DETECTED_KEY_DESCRIPTION,
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

function readJobJsonFields(
  paprDir: string,
  jobId: string,
): { command: string | null; requiredKeys: string[] } {
  const jobJsonPath = path.join(paprDir, "Jobs", jobId, "job.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(jobJsonPath, "utf8")) as {
      command?: string;
      requiredKeys?: unknown;
    };
    const command =
      typeof parsed.command === "string" ? parsed.command : null;
    const requiredKeys = Array.isArray(parsed.requiredKeys)
      ? parsed.requiredKeys
          .filter((key): key is string => typeof key === "string")
          .map((key) => key.trim())
          .filter((key) => key.length > 0)
      : [];
    return { command, requiredKeys };
  } catch {
    return { command: null, requiredKeys: [] };
  }
}

function readAppsJsonEntry(
  paprDir: string,
  appId: string,
): { agentChat?: AppAgentChatConfig } | null {
  const appsPath = path.join(paprDir, "data", "apps.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(appsPath, "utf8")) as Array<{
      id?: string;
      agentChat?: AppAgentChatConfig;
    }>;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const entry = parsed.find((app) => app.id === appId);
    return entry ?? null;
  } catch {
    return null;
  }
}

function readSubAgentProfile(
  paprDir: string,
  subAgentId: string,
): SubAgentProfile | null {
  const subagentsPath = path.join(paprDir, "data", "subagents.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(subagentsPath, "utf8")) as SubAgentProfile[];
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.find((profile) => profile.id === subAgentId) ?? null;
  } catch {
    return null;
  }
}

function readJobProvider(paprDir: string, jobId: string): Provider | null {
  const jobJsonPath = path.join(paprDir, "Jobs", jobId, "job.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(jobJsonPath, "utf8")) as {
      provider?: Provider;
    };
    return parsed.provider ?? null;
  } catch {
    return null;
  }
}

/**
 * LLM env keys implied by enabled embedded app-agent chat (sub-agent + cloud job providers).
 */
export function readAgentChatLlmKeyNames(paprDir: string, appId: string): string[] {
  const appEntry = readAppsJsonEntry(paprDir, appId);
  const agentChat = appEntry?.agentChat;
  if (!agentChat?.enabled || !agentChat.subAgentId?.trim()) {
    return [];
  }

  const profile = readSubAgentProfile(paprDir, agentChat.subAgentId.trim());
  const providers: Array<Provider | string | undefined> = [
    profile?.provider,
    profile?.fallbackProvider,
  ];

  const cloudJobId = agentChat.cloudJobId?.trim();
  if (cloudJobId) {
    providers.push(readJobProvider(paprDir, cloudJobId) ?? undefined);
  }

  return collectLlmEnvKeysForProviders(providers);
}

export type LinkedJobKeySource = "requiredKeys" | "command";

export interface LinkedJobCatalogKeyRef {
  jobId: string;
  keyName: string;
  source: LinkedJobKeySource;
}

/** Keys linked jobs need for cloud publish catalog (command ${KEY} + job.json requiredKeys). */
export function readLinkedJobCatalogKeyRefs(
  paprDir: string,
  appId: string,
): LinkedJobCatalogKeyRef[] {
  const refs: LinkedJobCatalogKeyRef[] = [];
  const seen = new Set<string>();

  for (const jobId of resolveAppDependentJobIds(paprDir, appId)) {
    const { command, requiredKeys } = readJobJsonFields(paprDir, jobId);
    for (const keyName of requiredKeys) {
      if (isPlatformInjectedEnvKey(keyName)) {
        continue;
      }
      const dedupe = `${jobId}\0${keyName}\0requiredKeys`;
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      refs.push({ jobId, keyName, source: "requiredKeys" });
    }
    if (command) {
      for (const keyName of extractCustomKeyNames(command)) {
        if (isPlatformInjectedEnvKey(keyName)) {
          continue;
        }
        const dedupe = `${jobId}\0${keyName}\0command`;
        if (seen.has(dedupe)) {
          continue;
        }
        seen.add(dedupe);
        refs.push({ jobId, keyName, source: "command" });
      }
    }
  }

  refs.sort((a, b) =>
    a.keyName === b.keyName
      ? a.jobId.localeCompare(b.jobId)
      : a.keyName.localeCompare(b.keyName),
  );
  return refs;
}

/** Distinct key names from {@link readLinkedJobCatalogKeyRefs}. */
export function readLinkedJobKeyNames(
  paprDir: string,
  appId: string,
): string[] {
  const names = new Set<string>();
  for (const ref of readLinkedJobCatalogKeyRefs(paprDir, appId)) {
    names.add(ref.keyName);
  }
  return [...names].sort();
}

/** Linked job keys not yet listed in apps/{appId}/requirements.json (publish vault catalog). */
export function readLinkedJobKeysMissingFromSavedRequirements(
  paprDir: string,
  appId: string,
): LinkedJobCatalogKeyRef[] {
  const savedNames = new Set([
    ...readAppRequirements(paprDir, appId).map((spec) => spec.name),
    ...readAppNotKeys(paprDir, appId),
  ]);
  return readLinkedJobCatalogKeyRefs(paprDir, appId).filter(
    (ref) => !savedNames.has(ref.keyName),
  );
}

/**
 * What gets published: requirements.json plus embedded-chat LLM keys.
 *
 * Embedded-chat keys are known exactly (provider → env var), so they are
 * added with a real description. Names found in backend/manifest.json and
 * linked jobs are NOT added here any more: they have to be declared
 * (declare_app_keys / Share → API keys), and {@link checkAppKeyDeclarations}
 * blocks publish until they are.
 */
export async function readEffectiveAppRequirements(
  paprDir: string,
  appId: string,
): Promise<RequiredKeySpec[]> {
  const fromFile = readAppRequirements(paprDir, appId);
  const agentChatLlmKeys = readAgentChatLlmKeyNames(paprDir, appId);
  return mergeAgentChatLlmKeysIntoRequirements(fromFile, agentChatLlmKeys);
}

/** Every key name found in backend/manifest.json and linked jobs, with where. */
export async function readDetectedAppKeyRefs(
  paprDir: string,
  appId: string,
): Promise<DetectedKeyRef[]> {
  const refs: DetectedKeyRef[] = [];
  for (const name of await readBackendManifestKeyNames(paprDir, appId)) {
    refs.push({ name, source: "backend" });
  }
  for (const ref of readLinkedJobCatalogKeyRefs(paprDir, appId)) {
    refs.push({
      name: ref.keyName,
      source: ref.source === "requiredKeys" ? "job-requiredKeys" : "job-command",
      jobId: ref.jobId,
    });
  }
  return refs;
}

async function readOwnerVaultKeyNames(): Promise<Set<string>> {
  try {
    const { getCustomKeysService } = await import("./CustomKeysService.js");
    const keys = await getCustomKeysService().listKeys();
    return new Set(keys.map((key) => key.name));
  } catch {
    return new Set();
  }
}

/**
 * Keys that still need a decision before this app can publish.
 * The owner's vault (names only) is used for hints, never to decide.
 */
export async function checkAppKeyDeclarations(
  paprDir: string,
  appId: string,
  options?: { ownerVaultKeyNames?: ReadonlySet<string> },
): Promise<UndeclaredKey[]> {
  return findUndeclaredKeys({
    saved: await readEffectiveAppRequirements(paprDir, appId),
    detected: await readDetectedAppKeyRefs(paprDir, appId),
    notKeys: readAppNotKeys(paprDir, appId),
    ownerVaultKeyNames:
      options?.ownerVaultKeyNames ?? (await readOwnerVaultKeyNames()),
  });
}

/** Throws {@link AppKeysUndeclaredError} when any key still needs a decision. */
export async function assertAppKeysDeclared(
  paprDir: string,
  appId: string,
): Promise<void> {
  const undeclared = await checkAppKeyDeclarations(paprDir, appId);
  if (undeclared.length > 0) {
    throw new AppKeysUndeclaredError(appId, undeclared);
  }
}

/**
 * Publish never blocks on undeclared keys (validate_app is where the agent
 * fixes them). Until declared, a credential-shaped key found in the backend or
 * a linked job is published as an OWNER key: it resolves from the publisher's
 * vault and is never shown to visitors. That is what old apps did before
 * declaring existed, so they keep working. Not written to requirements.json.
 */
export async function undeclaredOwnerFallbackNames(
  paprDir: string,
  appId: string,
  saved: RequiredKeySpec[],
): Promise<string[]> {
  const savedNames = new Set(saved.map((spec) => spec.name));
  const notKeys = new Set(readAppNotKeys(paprDir, appId));
  const names = new Set<string>();
  for (const ref of await readDetectedAppKeyRefs(paprDir, appId)) {
    const name = ref.name.trim();
    if (!name || savedNames.has(name) || notKeys.has(name)) continue;
    // ${TASK}-style command parameters are not keys.
    if (ref.source === "job-command" && !looksLikeCredentialName(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

export interface AppRequirementsDiscovery {
  requirements: RequiredKeySpec[];
  savedRequirements: RequiredKeySpec[];
  detectedKeyNames: string[];
  notKeys: string[];
  undeclared: UndeclaredKey[];
}

/**
 * For Share → API keys: saved rows plus a draft row per undeclared detected
 * key, so the publisher can decide (Mine / Theirs / Remove = not a key).
 */
export async function discoverAppRequirements(
  paprDir: string,
  appId: string,
): Promise<AppRequirementsDiscovery> {
  const savedRequirements = readAppRequirements(paprDir, appId);
  const effective = await readEffectiveAppRequirements(paprDir, appId);
  const undeclared = await checkAppKeyDeclarations(paprDir, appId);
  const effectiveNames = new Set(effective.map((spec) => spec.name));
  const drafts = undeclared
    .filter((key) => !effectiveNames.has(key.name))
    .map((key) => key.name);
  const requirements = mergeBackendKeysIntoRequirements(effective, drafts).map(
    (spec) =>
      drafts.includes(spec.name) && undeclared.find((k) => k.name === spec.name)?.suggestion === "user"
        ? { ...spec, credentialScope: "user" as const }
        : spec,
  );
  const savedNames = new Set(savedRequirements.map((spec) => spec.name));
  const detectedKeyNames = requirements
    .map((spec) => spec.name)
    .filter((name) => !savedNames.has(name));
  return {
    requirements,
    savedRequirements,
    detectedKeyNames,
    notKeys: readAppNotKeys(paprDir, appId),
    undeclared,
  };
}

/**
 * Keep requirements.json in step with things that are known exactly
 * (embedded-chat LLM keys). Detected backend/job key names are not written:
 * they are reported by {@link checkAppKeyDeclarations} instead.
 */
export async function ensureAppRequirementsSyncedWithBackend(
  paprDir: string,
  appId: string,
): Promise<{ updated: boolean; requirements: RequiredKeySpec[] }> {
  const existing = readAppRequirements(paprDir, appId);
  const merged = await readEffectiveAppRequirements(paprDir, appId);
  const existingNames = new Set(existing.map((spec) => spec.name));
  const added = merged.filter((spec) => !existingNames.has(spec.name));
  if (added.length > 0) {
    writeAppRequirements(paprDir, appId, merged);
    console.log(
      `[CloudRequirements] Added embedded-chat LLM keys to requirements.json for ${appId}: ${added.map((spec) => spec.name).join(", ")}`,
    );
  }
  // The published list also carries undeclared keys as owner keys; the file
  // on disk stays declarations-only.
  const fallback = await undeclaredOwnerFallbackNames(paprDir, appId, merged);
  return {
    updated: added.length > 0,
    requirements:
      fallback.length > 0 ? mergeBackendKeysIntoRequirements(merged, fallback) : merged,
  };
}
