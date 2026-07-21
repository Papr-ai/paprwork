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
      const status = await window.electronAPI.papr.getStatus();
      if (!status.success || !status.isLoggedIn) {
        setIsLoggedIn(false);
        setUserId(null);
        setNamespaceId(null);
        setNamespaceName(null);
        setWorkspaceName(null);
        return;
      }

      setIsLoggedIn(true);
      const profile = await window.electronAPI.papr.getProfile();
      if (profile.success && profile.profile) {
        setUserId(profile.profile.userId ?? null);
        setNamespaceId(profile.profile.activeNamespaceId ?? null);
        setNamespaceName(profile.profile.activeNamespaceName ?? null);
        setWorkspaceName(profile.profile.workspaceName ?? null);
      } else {
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
    const onNamespaceChanged = (data: { namespaceId: string; namespaceName: string }) => {
      setNamespaceId(data.namespaceId);
      setNamespaceName(data.namespaceName);
    };
    window.electronAPI.papr.onNamespaceChanged(onNamespaceChanged);
    return () => {
      window.electronAPI.papr.removeNamespaceChangedListener(onNamespaceChanged);
    };
  }, []);

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
