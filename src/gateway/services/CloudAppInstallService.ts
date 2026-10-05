/**
 * Install cloud mini-app source into local Paprwork (fork or track).
 */

import { getPaprRoot, getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import {
  parseProposableMetadata,
  pickProposableMetadata,
} from "./cloudSync/contributeMetadataFields.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  CLOUD_APP_REQUIREMENTS_FILENAME,
  parseRequirementsFileContent,
  readAppRequirements,
} from "./cloudAppRequirements.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type {
  CloudAppInstallMode,
  CloudAppLineageFile,
} from "../../core/types/cloudAppLineage.js";
import type { InstallBootstrapResult } from "./cloudAppInstallBootstrap.js";
import { serializeCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import { applyIdRemapsToDirectory } from "../utils/applyIdRemaps.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import {
  getAppService,
  type AppFile,
  type MiniApp,
} from "./AppService.js";
import { cloneCloudAppSource } from "./cloudSync/cloudGitClone.js";
import type {
  CloudAppDependenciesFile,
  CloudInstallHealthReport,
} from "../../core/types/cloudAppDependencies.js";

interface MemoryInstallResponse {
  mode: CloudAppInstallMode;
  source: {
    orgId: string;
    namespaceId: string;
    userId: string;
    appId: string;
    slug: string;
  };
  repoPath: string;
  cloneUrl: string;
  token: string;
  expiresAt: string;
  lineageId: string;
  /** Caller's verified access to the source app (owner/team/public_read/link_*). */
  accessMode?: string | null;
}

export interface CloudAppInstallInput {
  namespaceId: string;
  slug: string;
  mode?: CloudAppInstallMode;
  installDbPolicy?: import("./cloudInstallDbPolicy.js").InstallDbPolicy;
  shareToken?: string;
  /** Catalog tab scope — community (global) forbids track. */
  catalogScope?: "global" | "namespace";
  /** Publish visibility from catalog entry — track requires team. */
  visibility?: string;
  /** Name for the new app (Duplicate as my own app). Made unique locally. */
  title?: string;
  /** Who the source is shared with (team / people / community), for the lineage mark. */
  sourceAudience?: "team" | "people" | "community";
}

export interface CloudAppInstallResult {
  app: MiniApp;
  lineageId: string;
  mode: CloudAppInstallMode;
  sourceAppId: string;
  sourceSlug: string;
  requirements: RequiredKeySpec[];
  remappedFiles: string[];
  bootstrap: InstallBootstrapResult;
  /** Pre-filled agent prompt when bootstrap needs follow-up. */
  agentSetupMessage?: string;
  copiedJobIds: string[];
  promotedJobIds: string[];
  skippedSparsePaths: string[];
  dependencies: CloudAppDependenciesFile | null;
  health: CloudInstallHealthReport;
  installWarnings: string[];
}

async function collectAppFiles(
  rootDir: string,
  baseDir: string = rootDir,
): Promise<AppFile[]> {
  const files: AppFile[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "papr-cloud-lineage.json") continue;

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectAppFiles(fullPath, baseDir)));
      continue;
    }

    const relative = path.relative(baseDir, fullPath);
    const content = await fs.readFile(fullPath, "utf8");
    files.push({ filename: relative, content });
  }

  return files;
}

async function cloneAppSource(
  prepare: MemoryInstallResponse,
): Promise<{ sourceDir: string; repoDir: string; cleanup: () => Promise<void> }> {
  return cloneCloudAppSource(
    {
      cloneUrl: prepare.cloneUrl,
      token: prepare.token,
      repoPath: prepare.repoPath,
    },
    "papr-cloud-install-",
  );
}

/**
 * Baselines for field-level metadata proposals: what the copy's metadata.json
 * says right after install (incl. the "_2" title suffix) and what the
 * publisher's said.
 */
async function readInstallMetadataBaselines(
  appDir: string,
  files: AppFile[],
  app: { title: string; description: string; icon?: string; tags?: string[] },
): Promise<{
  metadataBaseline: ReturnType<typeof pickProposableMetadata>;
  metadataUpstreamBaseline?: ReturnType<typeof pickProposableMetadata>;
}> {
  let onDisk: ReturnType<typeof pickProposableMetadata> | null = null;
  try {
    onDisk = parseProposableMetadata(
      await fs.readFile(path.join(appDir, "metadata.json"), "utf8"),
    );
  } catch {
    onDisk = null;
  }
  const upstream = parseProposableMetadata(
    files.find((file) => file.filename === "metadata.json")?.content,
  );
  return {
    metadataBaseline:
      onDisk && onDisk.title
        ? onDisk
        : pickProposableMetadata({
            title: app.title,
            description: app.description,
            icon: app.icon,
            tags: app.tags,
          }),
    ...(upstream ? { metadataUpstreamBaseline: upstream } : {}),
  };
}

function resolveTitle(files: AppFile[], slug: string): string {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { title?: string };
      if (parsed.title?.trim()) {
        return parsed.title.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveDescription(files: AppFile[], fallback: string): string {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { description?: string };
      if (parsed.description?.trim()) {
        return parsed.description.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

function resolveIcon(files: AppFile[]): string | undefined {
  const metadata = files.find((file) => file.filename === "metadata.json");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata.content) as { icon?: string };
      if (parsed.icon?.trim()) {
        return parsed.icon.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export class CloudAppInstallService {
  async prepareInstall(
    input: CloudAppInstallInput,
  ): Promise<MemoryInstallResponse> {
    const response = await cloudApiFetch("/v1/cloud/apps/install", {
      method: "POST",
      body: {
        namespaceId: input.namespaceId,
        slug: input.slug,
        mode: input.mode ?? "fork",
        shareToken: input.shareToken,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloud install prepare failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as MemoryInstallResponse;
  }

  async installApp(input: CloudAppInstallInput): Promise<CloudAppInstallResult> {
    const mode = input.mode ?? "fork";
    const {
      assertTrackAccessFromServer,
      assertTrackAllowedForCatalog,
      databasePolicyFromInstallPolicy,
      readLinkedDbIsolations,
      resolveInstallDbPolicy,
    } = await import("./cloudInstallDbPolicy.js");

    assertTrackAllowedForCatalog({
      mode,
      catalogScope: input.catalogScope,
      visibility: input.visibility,
    });

    const prepare = await this.prepareInstall({ ...input, mode });
    assertTrackAccessFromServer({
      mode,
      catalogScope: input.catalogScope,
      accessMode: prepare.accessMode,
      explicitPolicy: input.installDbPolicy,
    });
    const cloned = await cloneAppSource(prepare);

    const linkedIsolations = await readLinkedDbIsolations({
      repoPaprHome: cloned.repoDir,
      repoAppDir: cloned.sourceDir,
    });
    // catalogScope matters: community collaborate tracks code but must never
    // attach the publisher's database.
    const installDbPolicy = resolveInstallDbPolicy(
      mode,
      linkedIsolations,
      input.catalogScope,
      input.installDbPolicy,
      prepare.accessMode,
    );
    const databasePolicy = databasePolicyFromInstallPolicy(installDbPolicy);

    let createdAppId: string | null = null;
    // Fork databases created by this install — dropped (local + cloud) on rollback.
    let forkDbIdsForRollback: string[] = [];

    try {
      const files = await collectAppFiles(cloned.sourceDir);

      if (files.length === 0) {
        throw new Error(
          `No app files found at ${prepare.repoPath} in owner repo`,
        );
      }

      const title = input.title?.trim() || resolveTitle(files, prepare.source.slug);
      const description = resolveDescription(
        files,
        `Installed from Papr Cloud (${prepare.source.slug})`,
      );
      const icon = resolveIcon(files);

      const appService = getAppService();
      const app = await appService.createApp(
        title,
        description,
        files,
        icon,
        undefined,
        undefined,
        undefined,
        // Forked/tracked from the Cloud catalog — not original builder work.
        { creationSource: "install" },
      );
      createdAppId = app.id;

      const remaps = new Map<string, string>([[prepare.source.appId, app.id]]);
      const appDir = path.join(getPaprAppsRoot(), app.id);
      const { remappedFiles } = await applyIdRemapsToDirectory(appDir, remaps);
      if (remappedFiles.length > 0) {
        console.log(
          `[CloudAppInstall] Remapped publisher app ID in ${remappedFiles.length} file(s) for ${app.id}`,
        );
      }

      const { installCloudAppLinkedResources, finalizePortableCloudAppResources } =
        await import("./cloudAppLinkedResourcesInstall.js");
      const linked = await installCloudAppLinkedResources({
        repoDir: cloned.repoDir,
        repoAppDir: cloned.sourceDir,
        publisherAppId: prepare.source.appId,
        localAppId: app.id,
        installDbPolicy,
        remapJobIds: prepare.mode === "fork",
      });
      if (linked.copiedJobIds.length > 0) {
        console.log(
          `[CloudAppInstall] Installed ${linked.copiedJobIds.length} linked job(s) for ${app.id}`,
        );
      }

      await finalizePortableCloudAppResources({ cloudInstall: true });

      const { hydrateAppFolderSchemaMigrationsToRegistry } = await import(
        "./syncV3/syncPulledSchemaOwnerMigrations.js"
      );
      const hydratedMigrations = await hydrateAppFolderSchemaMigrationsToRegistry({
        appId: app.id,
      });
      if (hydratedMigrations.copied.length > 0) {
        console.log(
          `[CloudAppInstall] Mirrored ${hydratedMigrations.copied.length} migration(s) from app folder into registry for ${app.id}`,
        );
      }

      // One decision point for how each installed database is stored on this
      // device (replica / cloud-direct / local), made before any migration runs.
      const { provisionInstalledDatabases, resetForkDatabaseForRetry } =
        await import("./installDatabaseProvisioning.js");
      if (installDbPolicy === "fork_empty") {
        forkDbIdsForRollback = [...linked.registryDbIds];
      }
      await provisionInstalledDatabases({
        registryDbIds: linked.registryDbIds,
        installDbPolicy,
      });

      const installWarnings = [...linked.health.warnings];
      if (linked.skippedSparsePaths.length > 0) {
        installWarnings.push(
          `Skipped ${linked.skippedSparsePaths.length} missing repo path(s) during sparse-checkout`,
        );
      }

      if (!linked.health.ok) {
        const missingParts: string[] = [];
        if (linked.health.missingJobIds.length > 0) {
          missingParts.push(
            `jobs: ${linked.health.missingJobIds.slice(0, 5).join(", ")}`,
          );
        }
        if (linked.health.missingRequiredDbIds.length > 0) {
          missingParts.push(
            `databases: ${linked.health.missingRequiredDbIds.slice(0, 5).join(", ")}`,
          );
        }
        throw Object.assign(
          new Error(
            `Install incomplete — required linked resources missing (${missingParts.join("; ")})`,
          ),
          {
            code: "install_linked_resources_missing",
            status: 422,
            detail: JSON.stringify({
              missingJobIds: linked.health.missingJobIds,
              missingRequiredDbIds: linked.health.missingRequiredDbIds,
              warnings: linked.health.warnings,
            }).slice(0, 4000),
          },
        );
      }

      const {
        bootstrapInstalledAppDatabases,
        buildCloudInstallAgentSetupMessage,
        shouldOfferInstallAgentSetup,
      } = await import("./cloudAppInstallBootstrap.js");
      const deferTursoUntilPublish =
        mode === "fork" ||
        (mode === "track" && input.catalogScope === "global");
      let bootstrap = await bootstrapInstalledAppDatabases(app.id, {
        installDbPolicy,
        deferTursoUntilPublish,
      });

      // Fork: one clean-slate retry (drop the fresh databases, re-provision,
      // re-migrate). A second failure fails the whole install and rolls back —
      // never leave a half-initialized database behind for the next attempt.
      if (bootstrap.errors.length > 0 && installDbPolicy === "fork_empty") {
        console.warn(
          `[CloudAppInstall] Bootstrap failed for ${app.id}, retrying once from a clean slate:`,
          bootstrap.errors.slice(0, 3).join(" | "),
        );
        for (const dbId of forkDbIdsForRollback) {
          await resetForkDatabaseForRetry(dbId);
        }
        bootstrap = await bootstrapInstalledAppDatabases(app.id, {
          installDbPolicy,
          deferTursoUntilPublish,
        });
        if (bootstrap.errors.length > 0) {
          // Raw SQL/engine detail goes to the log; the user gets one plain
          // sentence and a clean slate (rollback below removes everything).
          console.error(
            `[CloudAppInstall] Database setup failed twice for ${app.id}:`,
            bootstrap.errors.join(" | "),
          );
          throw Object.assign(
            new Error(
              `Couldn't set up the database for "${app.title}". Nothing was installed — ` +
                "please try again. If it keeps failing, the publisher may need to publish a fix.",
            ),
            {
              code: "install_db_setup_failed",
              status: 422,
              // Raw engine errors for the agent setup chat — the UI never shows
              // these to the user directly, but without them the agent has
              // nothing to diagnose (gateway stdout is not persisted).
              detail: bootstrap.errors.join("\n").slice(0, 4000),
            },
          );
        }
      }

      if (bootstrap.errors.length > 0) {
        console.warn(
          `[CloudAppInstall] Bootstrap errors for ${app.id} — returning agent follow-up instead of failing install:`,
          bootstrap.errors.slice(0, 3).join(" | "),
        );
      }

      const agentSetupMessage = shouldOfferInstallAgentSetup(
        bootstrap,
        installDbPolicy,
      )
        ? buildCloudInstallAgentSetupMessage({
            appTitle: app.title,
            appId: app.id,
            sourceSlug: prepare.source.slug,
            bootstrap,
            linkedJobIds: linked.copiedJobIds,
          })
        : undefined;

      if (bootstrap.warnings.length > 0) {
        console.warn(
          `[CloudAppInstall] Bootstrap warnings for ${app.id}:`,
          bootstrap.warnings.slice(0, 3).join(" | "),
        );
      }

      // The publisher commit this copy starts from. Proposals branch from it
      // and pulls merge against it (see cloudSync/threeWayMerge.ts).
      const { readHeadCommit } = await import("./cloudSync/threeWayMerge.js");
      const baseCommit = await readHeadCommit(cloned.repoDir);

      const lineage: CloudAppLineageFile = {
        schemaVersion: "1.2.0",
        lineageId: prepare.lineageId,
        mode: prepare.mode,
        source: prepare.source,
        databasePolicy,
        ...(baseCommit ? { baseCommit } : {}),
        ...(input.sourceAudience ? { sourceAudience: input.sourceAudience } : {}),
        installedAt: new Date().toISOString(),
        ...(prepare.mode === "track"
          ? {
              lastSyncedAt: new Date().toISOString(),
              trackAutoPull: false,
              // Hash what is on disk (after publisher→local ID remap), not the
              // raw upstream files; otherwise remapped files look like local
              // edits and every "Update from publisher" reports them as conflicts.
              syncSnapshot: await snapshotAppDirHashes(appDir),
              // What this copy's title/description/icon/tags start as (incl.
              // the "_2" suffix) so later edits to them can be proposed.
              ...(await readInstallMetadataBaselines(appDir, files, app)),
            }
          : {}),
      };

      if (prepare.mode === "track") {
        const { fetchPublisherRevisionSignedIn } = await import(
          "./syncV3/checkPublisherUpstreamRevision.js"
        );
        const upstreamRevision = await fetchPublisherRevisionSignedIn(
          prepare.source.namespaceId,
          prepare.source.slug,
        );
        if (upstreamRevision) {
          lineage.upstreamRevision = upstreamRevision;
        }
      }

      const paprDir = getPaprRoot();
      const lineagePath = path.join(getPaprAppsRoot(), app.id, "papr-cloud-lineage.json");
      await fs.writeFile(
        lineagePath,
        serializeCloudAppLineageFile(lineage),
        "utf8",
      );

      const requirementsFile = files.find(
        (file) => file.filename === CLOUD_APP_REQUIREMENTS_FILENAME,
      );
      const requirements = requirementsFile
        ? parseRequirementsFileContent(requirementsFile.content)
        : readAppRequirements(paprDir, app.id);

      return {
        app,
        lineageId: prepare.lineageId,
        mode: prepare.mode,
        sourceAppId: prepare.source.appId,
        sourceSlug: prepare.source.slug,
        requirements,
        remappedFiles,
        bootstrap,
        agentSetupMessage,
        copiedJobIds: linked.copiedJobIds,
        promotedJobIds: linked.promotedJobIds,
        skippedSparsePaths: linked.skippedSparsePaths,
        dependencies: linked.dependencies,
        health: linked.health,
        installWarnings,
      };
    } catch (error) {
      if (createdAppId) {
        try {
          const appService = getAppService();
          // confirmed: true — without it deleteApp only returns a preview and
          // a failed install silently leaves its app, jobs and databases behind.
          await appService.deleteApp(createdAppId, {
            confirmed: true,
            deleteLinkedJobs: true,
            deleteRegistryDbIds: forkDbIdsForRollback,
            deleteRegistryTurso: forkDbIdsForRollback.length > 0,
          });
          console.warn(
            `[CloudAppInstall] Rolled back partial install for app ${createdAppId}`,
          );
        } catch (rollbackError) {
          console.error(
            `[CloudAppInstall] Rollback failed for app ${createdAppId}:`,
            (rollbackError as Error).message,
          );
        }
      }
      throw error;
    } finally {
      await cloned.cleanup();
    }
  }
}

let instance: CloudAppInstallService | null = null;

export function getCloudAppInstallService(): CloudAppInstallService {
  if (!instance) {
    instance = new CloudAppInstallService();
  }
  return instance;
}

/** Hash every file on disk after install (post remap + linked resources). */
async function snapshotAppDirHashes(appDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, base: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "papr-cloud-lineage.json") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, base);
        continue;
      }
      const rel = path.relative(base, full).replace(/\\/g, "/");
      try {
        const content = await fs.readFile(full, "utf8");
        out[rel] = createHash("sha256").update(content, "utf8").digest("hex");
      } catch {
        /* skip unreadable files */
      }
    }
  }
  await walk(appDir, appDir);
  return out;
}
