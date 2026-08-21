export { buildDesktopHeartbeatBody } from "./buildDesktopHeartbeatBody.js";
export {
  AppRepoApiError,
  AppRepoNotFoundError,
  cloneUrlMatchesAppRepo,
  ensureAppRepoRecord,
  getAppRepoRecord,
  resolveAppRepoForSync,
} from "./AppRepoClient.js";
export {
  clearAppRepoRegistryCacheForTests,
  getCachedAppRepoRecord,
  readAppRepoRegistryCache,
  upsertCachedAppRepoRecord,
} from "./appRepoRegistryCache.js";
export {
  getDesktopSyncProtocol,
  getEnabledSyncV3Capabilities,
  isSyncV3FlagEnabled,
  isSyncV3SchemaLogEnabled,
} from "./syncV3Flags.js";
export {
  getSyncV3Metric,
  getSyncV3MetricsSnapshot,
  incrementSyncV3Metric,
  recordSyncV3Gauge,
  registerSyncV3TelemetrySink,
  resetSyncV3MetricsForTests,
} from "./syncV3Metrics.js";
export { postAppOps, fetchAppRepoHead, AppOpsClientError, AppOpsConflictError } from "./AppOpsClient.js";
export {
  appendOutboxEntry,
  clearSyncOutboxForTests,
  listOutboxEntries,
  listPendingOutboxEntries,
} from "./SyncOutbox.js";
export {
  applyAckedBlobOids,
  clearOidCacheForTests,
  getCachedBlobOid,
  readOidCache,
  seedOidCacheFromHead,
} from "./OidCache.js";
export { computeBlobOidForContent, computeBlobOidForFile, hashBlobContent } from "./computeParentHash.js";
export { collectAppOpFiles, refreshOpParentHashes } from "./collectAppOpFiles.js";
export { pushAppViaWriterOps } from "./pushAppViaWriterOps.js";
export {
  pushAppWriterOpsForPaprDir,
  pushAppViaWriterOpsFromSync,
} from "./pushAppWriterOpsCore.js";
export { finalizeAppRepoMutation } from "./finalizeAppRepoMutation.js";
export {
  reconcilePlatformCatalogManifest,
  readPlatformCatalogManifest,
  PLATFORM_CATALOG_MANIFEST_REL,
} from "./platformCatalogManifest.js";
export {
  getAppRepoWriterBaseUrl,
  isPerAppReposEnabled,
  shouldUseWriterOpsPath,
} from "./writerConfig.js";
export { notifyAppSaveForWriterOps } from "./AppSaveWatcher.js";
export {
  clearWriterConflictsForTests,
  listRecentWriterConflicts,
} from "./writerConflict.js";
export { isAppWriterSyncReady } from "./writerSyncStatus.js";
export {
  buildAppSyncV3Report,
  type AppSyncV3Report,
  type AppSyncV3ItemStatus,
  type AppSyncV3Phase,
} from "./appSyncV3StatusReport.js";
export {
  fanoutAppRepoCommitted,
  subscribeAppRepoCommitted,
  readAppRepoCommitCursors,
  writeAppRepoCommitCursor,
  clearAppRepoCommitCursorsForTests,
  type AppRepoCommittedEvent,
} from "./appRepoCommittedFanout.js";
export {
  startAppRepoRevisionSubscriber,
  stopAppRepoRevisionSubscriberForTests,
  receiveAppRepoCommittedEvent,
} from "./appRepoRevisionSubscriber.js";
export {
  ingestAppRepoCommittedEvent,
  isAppRepoCommittedEvent,
  parseAppRepoCommittedPayload,
} from "./appRepoCommittedInbound.js";
export {
  ensureWorkspaceLogGenesisForDb,
  runWorkspaceLogGenesisCutoverForAllLinkedSources,
  computeDbSnapshotHash,
  type WorkspaceLogGenesisCutoverSummary,
} from "./workspaceLogGenesisCutover.js";
export {
  appendWorkspaceLogEntry,
  readWorkspaceLogSince,
  writeWorkspaceLogGenesis,
  WorkspaceLogApiError,
} from "./WorkspaceLogClient.js";
export {
  appendAndMaterializeRowWrite,
  materializeWorkspaceLogSince,
  isWorkspaceLogRowsEnabled,
  resolveReplicaIdForSource,
} from "./LogMaterializer.js";
export {
  pullAppCodeFromRepo,
  pullDesktopAppOnRemoteCommit,
  appRepoMayHaveRemoteUpdates,
  type PullAppCodeFromRepoResult,
} from "./pullAppCodeFromRepo.js";
export {
  pullAppFromCloud,
  type PullAppFromCloudResult,
} from "./pullAppFromCloud.js";
