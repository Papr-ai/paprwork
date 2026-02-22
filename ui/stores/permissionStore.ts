/**
 * Permission Store - Zustand store for permission request state.
 *
 * Holds the pending permission request so both the chat inline card
 * and the fallback modal can consume the same state without duplicate listeners.
 */

import { create } from "zustand";
import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../types/permissions";

type ActiveRequest = KeyPermissionRequest & { requestId: string };

interface PermissionState {
  activeRequest: ActiveRequest | null;
  /** Whether the inline chat card has claimed this request (suppresses modal). */
  claimedByChat: boolean;
  setActiveRequest: (request: ActiveRequest | null) => void;
  claimForChat: () => void;
  respond: (response: KeyPermissionResponse) => void;
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  activeRequest: null,
  claimedByChat: false,

  setActiveRequest: (request) =>
    set({ activeRequest: request, claimedByChat: false }),

  claimForChat: () => set({ claimedByChat: true }),

  respond: (response) => {
    const { activeRequest } = get();
    if (!activeRequest) return;

    console.log("[PermissionStore] Responding:", response);

    // Check if running in Electron
    if (window.electronAPI?.permissions) {
      window.electronAPI.permissions.respondToRequest({
        requestId: activeRequest.requestId,
        keyName: activeRequest.keyName,
        response,
      });
    } else {
      console.warn(
        "[PermissionStore] Not running in Electron, cannot respond to permission request",
      );
    }

    set({ activeRequest: null, claimedByChat: false });
  },
}));

/**
 * Call once at app root to wire the Electron IPC listener into the store.
 */
export function initPermissionListener(): void {
  // Check if running in Electron
  if (!window.electronAPI?.permissions) {
    console.warn(
      "[PermissionStore] Not running in Electron, skipping permission listener",
    );
    return;
  }

  window.electronAPI.permissions.onKeyRequest(
    (
      _event: unknown,
      request: KeyPermissionRequest & { requestId: string },
    ) => {
      console.log("[PermissionStore] Request received:", request.keyName);
      usePermissionStore.getState().setActiveRequest(request);
    },
  );
}
