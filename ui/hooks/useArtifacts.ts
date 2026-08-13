/**
 * useArtifacts Hook - Artifact management operations
 */

import { useCallback, useEffect } from "react";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { gateway } from "../src/lib/gateway";
import {
  getActiveWorkspaceUiCacheKey,
  writeWorkspaceUiCache,
} from "../lib/workspaceUiCache";
import { normalizeTabHierarchy } from "../lib/persistedAppState";
import { useTabStore } from "../stores/tabStore";

export function useArtifacts(scope: "all" | "apps" = "all") {
  const {
    artifacts,
    loading,
    error,
    filter,
    searchQuery,
    setArtifacts,
    addArtifact,
    updateArtifact,
    removeArtifact,
    setLoading,
    setError,
    setFilter,
    setSearchQuery,
    toggleFavorite: toggleFavoriteLocal,
    getFilteredArtifacts,
  } = useArtifactsStore();

  const persistArtifactsToWorkspaceCache = useCallback((apps: Artifact[]) => {
    const key = getActiveWorkspaceUiCacheKey();
    if (!key) {
      return;
    }
    const {
      tabs,
      activeTabId,
      splitRatio,
      splitRatios,
      history,
      historyIndex,
    } = useTabStore.getState();
    const current = useArtifactsStore.getState().artifacts;
    writeWorkspaceUiCache(key, {
      tabs: normalizeTabHierarchy(tabs),
      activeTabId,
      splitRatio,
      splitRatios,
      history,
      historyIndex,
      artifacts: [
        ...current.filter((item) => item.type !== "app"),
        ...apps,
      ],
    });
  }, []);

  // Apps use a fast stale-while-refresh path; other views load both kinds.
  const loadArtifacts = useCallback(async () => {
    const cached = useArtifactsStore.getState().artifacts;
    const hasCachedApps = cached.some((item) => item.type === "app");
    const blockForLoad = scope === "all" || !hasCachedApps;
    if (blockForLoad) setLoading(true);
    setError(null);

    try {
      if (scope === "apps") {
        const response = await gateway.send("app:list", {}, { timeoutMs: 90_000 });
        const apps = (response.data as Artifact[]) || [];
        const current = useArtifactsStore.getState().artifacts;
        setArtifacts([
          ...current.filter((item) => item.type !== "app"),
          ...apps,
        ]);
        persistArtifactsToWorkspaceCache(apps);
      } else {
        const [docsResult, appsResult] = await Promise.allSettled([
          gateway.send("document:list"),
          gateway.send("app:list", {}, { timeoutMs: 90_000 }),
        ]);

        const documents =
          docsResult.status === "fulfilled"
            ? (docsResult.value.data as Artifact[]) || []
            : [];
        const apps =
          appsResult.status === "fulfilled"
            ? (appsResult.value.data as Artifact[]) || []
            : [];

        if (docsResult.status === "rejected") {
          console.error("[useArtifacts] document:list failed:", docsResult.reason);
          if (blockForLoad) setError("Failed to load documents");
        }
        if (appsResult.status === "rejected") {
          console.error("[useArtifacts] app:list failed:", appsResult.reason);
          const message =
            appsResult.reason instanceof Error
              ? appsResult.reason.message
              : "Failed to load apps";
          setError(
            message.includes("timeout")
              ? "Could not refresh apps — gateway is busy. Your apps are still on disk; try again in a moment."
              : message,
          );
        }

        setArtifacts([...documents, ...apps]);
        persistArtifactsToWorkspaceCache(apps);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load artifacts";
      const isAppListTimeout =
        scope === "apps" &&
        err instanceof Error &&
        message.toLowerCase().includes("timeout");
      if (blockForLoad || isAppListTimeout) {
        setError(
          isAppListTimeout
            ? "Could not refresh apps — gateway is busy. Your apps are still on disk; try again in a moment."
            : message,
        );
      }
      console.error("[useArtifacts] Load error:", err);
    } finally {
      if (blockForLoad) setLoading(false);
    }
  }, [scope, setArtifacts, setLoading, setError, persistArtifactsToWorkspaceCache]);

  // Create document
  const createDocument = useCallback(
    async (title: string, content: string = "") => {
      setError(null);

      try {
        const response = await gateway.send("document:create", {
          title,
          content,
        });
        const document = response.data as Artifact;
        addArtifact(document);
        return document;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create document";
        setError(message);
        console.error("[useArtifacts] Create document error:", err);
        return null;
      }
    },
    [addArtifact, setError],
  );

  // Create app
  const createApp = useCallback(
    async (
      title: string,
      description: string,
      files: Array<{ filename: string; content: string }>,
    ) => {
      setError(null);

      try {
        const response = await gateway.send("app:create", {
          title,
          description,
          files,
        });
        const app = response.data as Artifact;
        addArtifact(app);
        return app;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create app";
        setError(message);
        console.error("[useArtifacts] Create app error:", err);
        return null;
      }
    },
    [addArtifact, setError],
  );

  // Delete artifact
  const deleteArtifact = useCallback(
    async (
      id: string,
      type: "document" | "app",
      options?: { unpublishFromCloud?: boolean },
    ) => {
      setError(null);

      try {
        const messageType =
          type === "document" ? "document:delete" : "app:delete";
        const payloadKey = type === "document" ? "documentId" : "appId";

        // Deleting an app is not a local-only operation: the server checks
        // cloud publish status, and an unpublish additionally flips every
        // published App Files object to private one-by-one, then calls
        // DELETE /v1/cloud/apps/publish. Each of those uses cloudApiFetch,
        // whose own timeout is 60s — already twice the 30s default here, so
        // a single slow request guaranteed a spurious "Request timeout" in
        // the UI while the delete kept running server-side.
        // Matches the 90s budget app:list already uses.
        const response = await gateway.send(
          messageType,
          {
            [payloadKey]: id,
            ...(type === "app" && options?.unpublishFromCloud
              ? { unpublishFromCloud: true }
              : {}),
          },
          { timeoutMs: 90_000 },
        );
        const data = response.data as {
          deleted?: boolean;
          requiresUnpublishConfirm?: boolean;
          shareUrl?: string | null;
        };
        // Server says the app is live on the web. This is NOT an error — the
        // caller must re-prompt and retry with unpublishFromCloud: true. The
        // local publish cache goes stale (deleted/unpublished elsewhere), so
        // AppsView cannot reliably pre-detect this before calling.
        if (data?.requiresUnpublishConfirm) {
          return {
            deleted: false,
            requiresUnpublishConfirm: true,
            shareUrl: data.shareUrl ?? null,
          };
        }
        if (data?.deleted === false) {
          throw new Error(`Failed to delete ${type}`);
        }
        removeArtifact(id);
        return { deleted: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Failed to delete ${type}`;
        setError(message);
        console.error(`[useArtifacts] Delete ${type} error:`, err);
        throw err;
      }
    },
    [removeArtifact, setError],
  );

  // Toggle favorite
  const toggleFavorite = useCallback(
    async (id: string, type: "document" | "app") => {
      setError(null);

      try {
        const messageType =
          type === "document"
            ? "document:toggle-favorite"
            : "app:toggle-favorite";
        const payloadKey = type === "document" ? "documentId" : "appId";

        const response = await gateway.send(messageType, { [payloadKey]: id });
        const updated = response.data as Artifact;
        updateArtifact(id, { favorite: updated.favorite });

        // Auto-add to favorites sidebar when favoriting
        if (updated.favorite) {
          const artifact = artifacts.find((a) => a.id === id);
          if (artifact) {
            // Dispatch custom event for FavoritesList to listen to
            window.dispatchEvent(
              new CustomEvent("papr-favorite-added", {
                detail: {
                  id: artifact.id,
                  type: artifact.type,
                  title: artifact.title,
                  icon: artifact.icon,
                },
              }),
            );
          }
        } else {
          // Auto-remove from favorites sidebar when unfavoriting
          window.dispatchEvent(
            new CustomEvent("papr-favorite-removed", {
              detail: { id },
            }),
          );
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to toggle favorite";
        setError(message);
        console.error("[useArtifacts] Toggle favorite error:", err);
      }
    },
    [updateArtifact, toggleFavoriteLocal, setError, artifacts],
  );

  // Load artifacts on mount
  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts]);

  // Background refresh after workspace switch (cache already hydrated).
  useEffect(() => {
    const onArtifactsReady = () => {
      void loadArtifacts();
    };
    window.addEventListener("papr-workspace-artifacts-ready", onArtifactsReady);
    window.addEventListener("papr-workspace-switch-complete", onArtifactsReady);
    return () => {
      window.removeEventListener("papr-workspace-artifacts-ready", onArtifactsReady);
      window.removeEventListener(
        "papr-workspace-switch-complete",
        onArtifactsReady,
      );
    };
  }, [loadArtifacts]);

  // Agent/bash can change apps on disk; gateway prunes stale entries and broadcasts
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { type?: string }
        | undefined;
      if (detail?.type === "app:list-updated") {
        void loadArtifacts();
      }
    };
    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [loadArtifacts]);

  return {
    artifacts,
    filteredArtifacts: getFilteredArtifacts(),
    loading,
    error,
    filter,
    searchQuery,
    loadArtifacts,
    createDocument,
    createApp,
    deleteArtifact,
    toggleFavorite,
    setFilter,
    setSearchQuery,
  };
}
