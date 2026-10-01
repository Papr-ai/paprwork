/**
 * Install a Papr Cloud catalog app into the local workspace (fork or track).
 */

import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../src/core/types/communityCatalog";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
import type { CloudAppDependenciesFile } from "../../src/core/types/cloudAppDependencies";
import { normalizeRequirements } from "../../src/core/types/bundles";
import type { RequirementItem } from "../../src/core/types/bundles";
import { cloudAppInstallOverlayActions } from "../stores/cloudAppInstallOverlayStore";

export type CloudInstallMode = "fork" | "track";

export type CloudInstallDbPolicy = "fork_empty" | "shared_primary";

export interface CloudCatalogInstallSelection {
  mode: CloudInstallMode;
  /** Omitted by the one Install: the gateway picks own vs team data. */
  installDbPolicy?: CloudInstallDbPolicy;
}

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface CloudInstallResponse {
  app?: { id: string; title?: string };
  requirements?: RequiredKeySpec[];
  bootstrap?: {
    ready?: boolean;
    needsSeed?: boolean;
    warnings?: string[];
  };
  agentSetupMessage?: string;
  dependencies?: {
    apps: Array<{
      appId: string;
      title?: string;
      slug?: string;
      required: boolean;
      enables?: string[];
    }>;
    databases: Array<{
      dbId: string;
      alias?: string;
      ownerAppId: string;
      ownerTitle?: string;
      required: boolean;
      enables?: string[];
    }>;
  };
  installWarnings?: string[];
  health?: {
    ok?: boolean;
    missingJobIds?: string[];
    missingRequiredDbIds?: string[];
  };
  error?: string;
  /** Machine-readable failure code from the gateway (e.g. install_db_setup_failed). */
  code?: string;
  /** Raw engine/SQL detail for the agent — never shown to the user as-is. */
  detail?: string;
}

/** Failed install result — `code`/`detail` let callers route to agent setup. */
export interface CloudInstallFailure {
  ok: false;
  error: string;
  code?: string;
  detail?: string;
}

/** Gateway code for "database setup failed twice; install rolled back". */
export const INSTALL_DB_SETUP_FAILED_CODE = "install_db_setup_failed";

/** Gateway code when linked jobs/databases from the publisher bundle did not register. */
export const INSTALL_LINKED_RESOURCES_MISSING_CODE =
  "install_linked_resources_missing";

export function userProvidedRequirements(
  reqs: RequirementItem[] | RequiredKeySpec[] | undefined,
): RequiredKeySpec[] {
  if (!reqs?.length) return [];
  return normalizeRequirements(reqs).filter(
    (spec) => spec.required !== false && spec.credentialScope !== "owner",
  );
}

/** Append setup guidance when install succeeded but keys/platforms are still missing. */
export function enrichInstallAgentMessageWithRequirements(
  baseMessage: string,
  requirements: RequirementItem[] | RequiredKeySpec[] | undefined,
): string {
  const keys = userProvidedRequirements(requirements);
  if (keys.length === 0) {
    return baseMessage;
  }

  const lines = keys.map((spec) => {
    const label = spec.service?.trim() || spec.name;
    const hint = spec.instructions?.trim();
    return hint ? `${label} (\`${spec.name}\`) — ${hint}` : `${label} (\`${spec.name}\`)`;
  });

  return (
    `${baseMessage}\n\n` +
    `After the overview, still needed for full functionality: ${lines.join("; ")}.`
  );
}

export interface CloudInstallWelcomeInput {
  appTitle: string;
  appId: string;
  mode: CloudInstallMode;
  needsSeed?: boolean;
  catalogDescription?: string;
}

/** First message when install succeeded and the user should explore the app. */
export function buildCloudInstallWelcomeMessage(
  input: CloudInstallWelcomeInput,
): string {
  const modeLabel =
    input.mode === "track"
      ? "linked to the publisher for updates"
      : "installed in my workspace";

  const desc = input.catalogDescription?.trim();
  const lines = [
    `I just installed "${input.appTitle}" (appId: ${input.appId}) — ${modeLabel}. The app is open beside this chat.`,
    desc ? `Catalog description: ${desc}` : "",
    "",
    "Reply to me directly, in this order:",
    "1. Explain what this app is for and how I'll use it — plain language, a few short sentences.",
    "2. Tell me the first thing to click or do in the app to get value today.",
    "3. Then help with any remaining setup (API keys, platform sign-in, jobs, schedules). Offer connect_platform or Settings when useful.",
  ].filter(Boolean);

  if (input.needsSeed) {
    lines.push(
      "4. Data may still be empty — walk me through the seed/setup job if needed.",
    );
  }

  return lines.join("\n");
}

export interface PostInstallPlatformConnectHint {
  platformId: string;
  label: string;
  why: string;
}

/** Welcome + optional keys + optional platform connect — used after every cloud install. */
export function buildPostInstallAgentMessage(input: {
  appTitle: string;
  appId: string;
  mode: CloudInstallMode;
  needsSeed?: boolean;
  catalogDescription?: string;
  requirements?: RequirementItem[] | RequiredKeySpec[];
  agentSetupMessage?: string;
  platformConnect?: PostInstallPlatformConnectHint;
}): string {
  const base =
    input.agentSetupMessage?.trim() ||
    buildCloudInstallWelcomeMessage({
      appId: input.appId,
      appTitle: input.appTitle,
      mode: input.mode,
      needsSeed: input.needsSeed,
      catalogDescription: input.catalogDescription,
    });

  let message = enrichInstallAgentMessageWithRequirements(
    base,
    input.requirements,
  );

  if (input.platformConnect) {
    message +=
      `\n\nPlatform: ${input.platformConnect.label} (${input.platformConnect.platformId}). ` +
      `${input.platformConnect.why} Help me connect when we reach setup step 3.`;
  }

  return message;
}

/** Large community apps (many jobs/DBs) can take a few minutes on slow networks. */
export const CLOUD_INSTALL_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

export const CLOUD_INSTALL_TIMEOUT_MESSAGE =
  "Install is taking longer than expected. Check your Apps list for a partial install, then try again.";

export function isCloudInstallTimeoutError(error: string): boolean {
  return error === CLOUD_INSTALL_TIMEOUT_MESSAGE;
}

/**
 * Database setup failure that should hand off to an agent chat.
 * Matches the current gateway code (install_db_setup_failed) and the legacy
 * message strings, so the handoff survives future copy changes.
 */
export function isCloudInstallBootstrapError(
  message: string,
  code?: string,
): boolean {
  if (code === INSTALL_DB_SETUP_FAILED_CODE) {
    return true;
  }
  return (
    message.includes("Database bootstrap failed:") ||
    message.includes("Couldn't set up the database for")
  );
}

export function isCloudInstallLinkedResourcesError(
  message: string,
  code?: string,
): boolean {
  if (code === INSTALL_LINKED_RESOURCES_MISSING_CODE) {
    return true;
  }
  return message.includes("Install incomplete — required linked resources missing");
}

/** Errors the UI should show inline (user picks fork/track, policy blocks, etc.). */
export function isCloudInstallUserActionError(code?: string): boolean {
  return (
    code === "install_mode_choice_required" ||
    code === "community_track_forbidden" ||
    code === "non_team_track_forbidden" ||
    code === "per_user_db"
  );
}

export type CloudInstallFailureHandoff =
  | { kind: "agent"; toast: string; agentMessage: string }
  | { kind: "user"; message: string };

/** Route install failures to agent chat unless the user must act in the UI first. */
export function planCloudInstallFailureHandoff(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
  failure: CloudInstallFailure,
): CloudInstallFailureHandoff {
  const { error: message, code, detail } = failure;

  if (isCloudInstallUserActionError(code)) {
    return { kind: "user", message };
  }

  if (isCloudInstallTimeoutError(message)) {
    return {
      kind: "agent",
      toast: `Install timed out for "${entry.name}" — opening chat for help…`,
      agentMessage: buildCloudInstallTimeoutAgentMessage(entry, mode),
    };
  }

  if (isCloudInstallBootstrapError(message, code)) {
    return {
      kind: "agent",
      toast: `Couldn't set up "${entry.name}" — opening chat to diagnose…`,
      agentMessage: buildCloudInstallBootstrapFailureAgentMessage(
        entry,
        mode,
        message,
        detail,
      ),
    };
  }

  if (isCloudInstallLinkedResourcesError(message, code)) {
    return {
      kind: "agent",
      toast: `"${entry.name}" is missing linked resources — opening chat to fix…`,
      agentMessage: buildCloudInstallLinkedResourcesFailureAgentMessage(
        entry,
        mode,
        message,
        detail,
      ),
    };
  }

  return {
    kind: "agent",
    toast: `"${entry.name}" install needs help — opening chat…`,
    agentMessage: buildCloudInstallGenericFailureAgentMessage(
      entry,
      mode,
      message,
      detail,
      code,
    ),
  };
}

export function buildCloudInstallLinkedResourcesFailureAgentMessage(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
  errorMessage: string,
  detail?: string,
): string {
  let parsedDetail = "";
  if (detail?.trim()) {
    try {
      const parsed = JSON.parse(detail) as {
        missingJobIds?: string[];
        missingRequiredDbIds?: string[];
        warnings?: string[];
      };
      const parts: string[] = [];
      if (parsed.missingJobIds?.length) {
        parts.push(`missing jobs: ${parsed.missingJobIds.join(", ")}`);
      }
      if (parsed.missingRequiredDbIds?.length) {
        parts.push(
          `missing required databases: ${parsed.missingRequiredDbIds.join(", ")}`,
        );
      }
      if (parsed.warnings?.length) {
        parts.push(`warnings: ${parsed.warnings.slice(0, 5).join(" | ")}`);
      }
      if (parts.length > 0) {
        parsedDetail = parts.join("\n");
      }
    } catch {
      parsedDetail = detail.trim();
    }
  }

  return [
    `Cloud install for "${entry.name}" (namespace: ${entry.namespaceId}, slug: ${entry.slug}, mode: ${mode}) failed because required linked resources from the publisher bundle did not register locally.`,
    "",
    "The gateway rolled back the partial install — the app folder should not remain on disk.",
    "",
    "What the user saw:",
    errorMessage,
    "",
    "Integrity detail:",
    parsedDetail || detail?.trim() || "(not provided — inspect publisher repo Jobs/ and databases registry expectations)",
    "",
    "Help me:",
    "1. Explain plainly what linked jobs/databases this app expects and why one might be missing (sparse checkout, unpublished DB, wrong track/collaborate policy, registry tombstone).",
    "2. Inspect local artifacts: databases registry, Jobs index, and any papr-cloud-lineage or dependency manifest under the publisher slug if a partial copy exists.",
    "3. Recommend a fix: re-publish from publisher, fork instead of collaborate, install missing optional deps, or repair registry entries — then retry install.",
    "4. Do not ask the user to read raw error codes; walk them through the fix.",
  ].join("\n");
}

export function buildCloudInstallGenericFailureAgentMessage(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
  errorMessage: string,
  detail?: string,
  code?: string,
): string {
  return [
    `Cloud install for "${entry.name}" (namespace: ${entry.namespaceId}, slug: ${entry.slug}, mode: ${mode}) failed.`,
    "",
    "The user should not see a dead-end error — diagnose and guide them to a working install.",
    "",
    "What the user saw:",
    errorMessage,
    ...(code ? [`Gateway code: ${code}`] : []),
    "",
    "Engine detail:",
    detail?.trim() || "(none returned)",
    "",
    "Check gateway logs, Apps list for partial installs, cloud lineage files, and retry or clean up as needed.",
  ].join("\n");
}

export function buildCloudInstallBootstrapFailureAgentMessage(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
  errorMessage: string,
  detail?: string,
): string {
  return [
    `Install of "${entry.name}" (namespace: ${entry.namespaceId}, slug: ${entry.slug}, mode: ${mode}) hit a database migration error and was rolled back — nothing was installed.`,
    "",
    "The user should not need to read SQLite errors — diagnose the root cause and explain it plainly.",
    "",
    "What the user saw:",
    errorMessage,
    "",
    "Engine detail (per linked database):",
    detail?.trim() || "(not provided by the gateway — replay the publisher's migrations on an empty DB to reproduce)",
    "",
    "The failing migrations belong to the PUBLISHER's app, so the fix is usually on the publisher side (new baseline migration, a schema snapshot at publish, or dropping a stale linked DB), then re-publish and retry the install.",
  ].join("\n");
}

export function buildCloudInstallTimeoutAgentMessage(
  entry: CommunityCatalogEntry,
  mode: CloudInstallMode,
): string {
  const timeoutMinutes = Math.round(CLOUD_INSTALL_FETCH_TIMEOUT_MS / 60_000);
  return [
    `Community app install for "${entry.name}" timed out in the UI after ${timeoutMinutes} minutes.`,
    "The gateway may still be finishing in the background.",
    "",
    "Please help me:",
    "1. Check Apps for a partial install (often a duplicate title like \"AppName_1\").",
    "2. Verify whether papr-cloud-lineage.json exists under the app folder.",
    "3. Complete the install, or delete the partial copy and retry cleanly.",
    "4. Open the app when it is ready.",
    "",
    `Publisher namespace: ${entry.namespaceId}`,
    `Slug: ${entry.slug}`,
    `Install mode: ${mode}`,
  ].join("\n");
}

export async function installCloudCatalogApp(
  entry: CommunityCatalogEntry,
  selection: CloudCatalogInstallSelection,
  options?: { catalogScope?: CommunityCatalogScope },
): Promise<{ ok: true; data: CloudInstallResponse } | CloudInstallFailure> {
  const { mode, installDbPolicy } = selection;
  if (!entry.namespaceId || !entry.slug) {
    return { ok: false, error: "This cloud app is missing namespace or slug metadata" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLOUD_INSTALL_FETCH_TIMEOUT_MS,
  );

  cloudAppInstallOverlayActions.begin(entry.name);

  try {
    const res = await fetch(`${GATEWAY}/api/cloud/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespaceId: entry.namespaceId,
        slug: entry.slug,
        mode,
        ...(installDbPolicy ? { installDbPolicy } : {}),
        catalogScope: options?.catalogScope,
        visibility: entry.visibility,
        communityCatalogListed: entry.communityCatalogListed,
      }),
      signal: controller.signal,
    });

    const body = (await res.json()) as CloudInstallResponse;
    if (!res.ok) {
      return {
        ok: false,
        error: body.error ?? `Install failed (${res.status})`,
        ...(body.code ? { code: body.code } : {}),
        ...(body.detail ? { detail: body.detail } : {}),
      };
    }

    return { ok: true, data: body };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: CLOUD_INSTALL_TIMEOUT_MESSAGE };
    }
    const message = err instanceof Error ? err.message : "Install failed";
    return { ok: false, error: message };
  } finally {
    cloudAppInstallOverlayActions.end();
    clearTimeout(timeout);
  }
}

export function extractOptionalInstallDependencies(
  body: CloudInstallResponse,
): CloudAppDependenciesFile | null {
  if (!body.dependencies) {
    return null;
  }
  const apps = body.dependencies.apps.filter((dep) => !dep.required);
  const databases = body.dependencies.databases.filter((dep) => !dep.required);
  if (apps.length === 0 && databases.length === 0) {
    return null;
  }
  return {
    schemaVersion: "1.0.0",
    updatedAt: new Date().toISOString(),
    apps,
    databases,
  };
}

export async function fetchAppFeatureAvailability(appId: string): Promise<
  import("../../src/core/types/cloudAppDependencies").AppFeatureAvailabilityReport
> {
  const res = await fetch(
    `${GATEWAY}/api/apps/${encodeURIComponent(appId)}/feature-availability`,
  );
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Feature availability failed (${res.status})`);
  }
  return (await res.json()) as import("../../src/core/types/cloudAppDependencies").AppFeatureAvailabilityReport;
}

export async function fetchCloudLineageIndex(): Promise<
  import("./communityAppLocalOpen").CloudLineageIndex | null
> {
  try {
    const res = await fetch(`${GATEWAY}/api/cloud/lineage`);
    if (!res.ok) return null;
    return (await res.json()) as import("./communityAppLocalOpen").CloudLineageIndex;
  } catch {
    return null;
  }
}
