/**
 * Hook for handling key permission requests
 */

import { useState, useEffect, useCallback } from "react";
import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../types/permissions";

export function useKeyPermissions() {
  const [activeRequest, setActiveRequest] = useState<
    (KeyPermissionRequest & { requestId: string }) | null
  >(null);

  useEffect(() => {
    const handler = (
      _event: any,
      request: KeyPermissionRequest & { requestId: string }
    ) => {
      console.log("[useKeyPermissions] Permission request received:", request);
      setActiveRequest(request);
    };

    window.electronAPI.permissions.onKeyRequest(handler);

    // Note: IPC listeners in Electron don't need cleanup in this pattern
    // The preload script manages the lifecycle
  }, []);

  const handleResponse = useCallback(
    (response: KeyPermissionResponse) => {
      if (!activeRequest) return;

      console.log("[useKeyPermissions] Sending response:", response);

      window.electronAPI.permissions.respondToRequest({
        requestId: activeRequest.requestId,
        keyName: activeRequest.keyName,
        response,
      });

      setActiveRequest(null);
    },
    [activeRequest]
  );

  return {
    activeRequest,
    handleResponse,
  };
}
