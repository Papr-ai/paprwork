/**
 * Core types - Re-export all types
 */

// Messages
export type {
  MessageRole,
  CoreMessage,
  PersistedMessage,
  CompactionEntry,
  ChatMetadata,
} from "./messages";

// Agents
export type {
  Provider,
  OpenAIReasoningEffort,
  ReasoningEffort,
  ModelReasoning,
  AgentConfig,
  AgentConfigInternal,
  ProviderConfig,
  ProvidersConfig,
  ModelInfo,
  SessionState,
} from "./agents";
export type {
  UiActiveAppFocus,
  UiAgentFocusContext,
  LastEditedKind,
  LastEditedFileRef,
  ResolvedAgentFocusContext,
} from "./agentFocus";
export type {
  SubAgentProfile,
  DelegationRunRecord,
  DelegationRunStatus,
  DelegateTaskInput,
} from "./subagents";

// Tools
export type {
  ToolResult,
  ToolExecution,
  BashToolInput,
  BashToolOutput,
  ReadToolInput,
  ReadToolOutput,
  WriteToolInput,
  WriteToolOutput,
  EditToolInput,
  EditToolOutput,
  ToolDefinition,
} from "./tools";

// Streaming
export type {
  StreamChunkType,
  StreamChunk,
  TextDeltaPayload,
  ReasoningDeltaPayload,
  ToolCallPayload,
  ToolCallDeltaPayload,
  ToolResultPayload,
  ErrorPayload,
  DonePayload,
  StreamingCallbacks,
} from "./streaming";

// Storage
export type {
  StorageEntry,
  IStorageManager,
  CompactionConfig,
  AppSettings,
} from "./storage";

// Permissions
export type {
  PermissionLevel,
  KeyPermission,
  KeyPermissionRequest,
  KeyPermissionResponse,
  PermissionSettings,
} from "./permissions";
export { DEFAULT_PERMISSION_SETTINGS } from "./permissions";

// Gateway IPC bridge
export type {
  RequestKeysMessage,
  KeysResponseMessage,
  RequestPermissionMessage,
  PermissionResponseMessage,
  GatewayToElectronIpcMessage,
  ElectronToGatewayIpcMessage,
} from "./gateway-ipc";
export {
  isKeysResponseMessage,
  isPermissionResponseMessage,
} from "./gateway-ipc";

// Bundle sharing + deployment manifests
export type {
  RuntimeType,
  BundleManifest,
  BundleAppSpec,
  BundleJobSpec,
  BundleDatabaseSpec,
  BundleDeploymentProfile,
} from "./bundles";
export {
  BUNDLE_SCHEMA_VERSION,
  RuntimeTypeSchema,
  BundleManifestSchema,
  parseBundleManifest,
} from "./bundles";
