/**
 * Desktop heartbeat request body for memory server capability handshake.
 */

import type { DesktopHeartbeatRequest } from "../../../core/types/syncV3.js";
import { resolveActiveNamespaceId } from "../../../core/utils/cloudReposScope.js";
import {
  getDesktopSyncProtocol,
  getEnabledSyncV3Capabilities,
} from "./syncV3Flags.js";

export function buildDesktopHeartbeatBody(
  appVersion?: string,
): DesktopHeartbeatRequest {
  const capabilities = getEnabledSyncV3Capabilities();
  const namespaceId = resolveActiveNamespaceId();

  const body: DesktopHeartbeatRequest = {
    syncProtocol: getDesktopSyncProtocol(),
  };

  if (appVersion?.trim()) {
    body.appVersion = appVersion.trim();
  }
  if (namespaceId) {
    body.namespaceId = namespaceId;
  }
  if (capabilities.length > 0) {
    body.syncV3Capabilities = capabilities;
  }

  return body;
}
