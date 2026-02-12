/**
 * Central Type Exports - Main entry point for all UI types
 * Import from here to ensure consistency across components
 */

// Chat types
export type {
  ChatMetadata,
  ChatMessage,
  ChatState,
  CreateChatPayload,
  UpdateChatPayload,
  DeleteChatPayload,
} from "./chat";

// Tab types
export type {
  Tab,
  TabType,
  DisplayMode,
  TabDragData,
  DragPosition,
} from "./tabs";

// Settings types
export type {
  CustomKey,
  CustomKeyInput,
  ProviderConfig,
  AppPreferences,
  UserProfile,
  PermissionLevel,
  SettingsTab,
} from "./settings";
