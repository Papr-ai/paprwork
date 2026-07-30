/**
 * Active Papr org/namespace context for cloud sharing tabs.
 */

import { useCallback, useEffect, useState } from "react";

export interface PaprNamespaceContext {
  isLoggedIn: boolean;
  userId: string | null;
  namespaceId: string | null;
  namespaceName: string | null;
  workspaceName: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function usePaprNamespace(): PaprNamespaceContext {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [namespaceId, setNamespaceId] = useState<string | null>(null);
  const [namespaceName, setNamespaceName] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await window.electronAPI.papr.checkLoginStatus();
      if (!status.success || !status.isLoggedIn) {
        setIsLoggedIn(false);
        setUserId(null);
        setNamespaceId(null);
        setNamespaceName(null);
        setWorkspaceName(null);
        return;
      }

      setIsLoggedIn(true);
      const workspace = await window.electronAPI.papr.getActiveWorkspace();
      if (workspace.success && workspace.pointer?.namespaceId) {
        setNamespaceId(workspace.pointer.namespaceId);
        setNamespaceName(workspace.pointer.namespaceName ?? null);
      }

      const profile = await window.electronAPI.papr.getProfile();
      if (profile.success && profile.profile) {
        setUserId(profile.profile.userId ?? null);
        if (!workspace.success || !workspace.pointer?.namespaceId) {
          setNamespaceId(profile.profile.activeNamespaceId ?? null);
          setNamespaceName(profile.profile.activeNamespaceName ?? null);
        }
        setWorkspaceName(profile.profile.workspaceName ?? null);
      } else if (!workspace.success || !workspace.pointer?.namespaceId) {
        setUserId(null);
        setNamespaceId(null);
        setNamespaceName(null);
        setWorkspaceName(null);
      }
    } catch {
      setIsLoggedIn(false);
      setUserId(null);
      setNamespaceId(null);
      setNamespaceName(null);
      setWorkspaceName(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onNamespaceChanged = () => {
      void refresh();
    };
    const onAuthChanged = () => {
      void refresh();
    };

    window.electronAPI.papr.onNamespaceChanged(onNamespaceChanged);
    window.electronAPI.papr.onOrganizationChanged(onNamespaceChanged);
    window.electronAPI.papr.onLoginSuccess(onAuthChanged);
    window.electronAPI.papr.onLogoutSuccess(onAuthChanged);
    window.addEventListener("papr-namespace-changed", onNamespaceChanged);
    window.addEventListener("papr-organization-changed", onNamespaceChanged);
    window.addEventListener("papr-auth-success", onAuthChanged);
    window.addEventListener("papr-logout-success", onAuthChanged);

    return () => {
      window.electronAPI.papr.removeNamespaceChangedListener(onNamespaceChanged);
      window.electronAPI.papr.removeOrganizationChangedListener(onNamespaceChanged);
      window.electronAPI.papr.removeLoginSuccessListener(onAuthChanged);
      window.electronAPI.papr.removeLogoutSuccessListener(onAuthChanged);
      window.removeEventListener("papr-namespace-changed", onNamespaceChanged);
      window.removeEventListener("papr-organization-changed", onNamespaceChanged);
      window.removeEventListener("papr-auth-success", onAuthChanged);
      window.removeEventListener("papr-logout-success", onAuthChanged);
    };
  }, [refresh]);

  return {
    isLoggedIn,
    userId,
    namespaceId,
    namespaceName,
    workspaceName,
    loading,
    refresh,
  };
}
