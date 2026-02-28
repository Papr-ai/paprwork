import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "./permissions.js";

export interface RequestKeysMessage {
  type: "REQUEST_KEYS";
  requestId: string;
  keys: string[];
}

export interface KeysResponseMessage {
  type: "KEYS_RESPONSE";
  requestId: string;
  keys: Record<string, string>;
  oauthTokens?: {
    openai?: {
      accessToken: string;
      expiresAt: string;
    };
    anthropic?: {
      accessToken: string;
      expiresAt: string;
    };
  };
}

export interface RequestPermissionMessage {
  type: "REQUEST_PERMISSION";
  requestId: string;
  request: KeyPermissionRequest;
}

export interface PermissionResponseMessage {
  type: "PERMISSION_RESPONSE";
  requestId: string;
  response: KeyPermissionResponse;
}

export interface WebviewTestRequest {
  action:
    | "launch"
    | "snapshot"
    | "execute"
    | "get_console"
    | "get_network"
    | "list"
    | "close";
  payload?: Record<string, unknown>;
}

export interface RequestWebviewTestMessage {
  type: "REQUEST_WEBVIEW_TEST";
  requestId: string;
  request: WebviewTestRequest;
}

export interface WebviewTestResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface WebviewTestResponseMessage {
  type: "WEBVIEW_TEST_RESPONSE";
  requestId: string;
  response: WebviewTestResponse;
}

export interface InvalidateKeyCacheMessage {
  type: "INVALIDATE_KEY_CACHE";
  keyName?: string; // Specific key to invalidate, or undefined for all keys
}

export type GatewayToElectronIpcMessage =
  | RequestKeysMessage
  | RequestPermissionMessage
  | RequestWebviewTestMessage;

export type ElectronToGatewayIpcMessage =
  | KeysResponseMessage
  | PermissionResponseMessage
  | WebviewTestResponseMessage
  | InvalidateKeyCacheMessage;

export function isKeysResponseMessage(
  message: unknown,
): message is KeysResponseMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "KEYS_RESPONSE" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.keys === "object" &&
    candidate.keys !== null
  );
}

export function isPermissionResponseMessage(
  message: unknown,
): message is PermissionResponseMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "PERMISSION_RESPONSE" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.response === "object" &&
    candidate.response !== null
  );
}

export function isWebviewTestResponseMessage(
  message: unknown,
): message is WebviewTestResponseMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "WEBVIEW_TEST_RESPONSE" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.response === "object" &&
    candidate.response !== null
  );
}

export function isInvalidateKeyCacheMessage(
  message: unknown,
): message is InvalidateKeyCacheMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "INVALIDATE_KEY_CACHE" &&
    (candidate.keyName === undefined || typeof candidate.keyName === "string")
  );
}
