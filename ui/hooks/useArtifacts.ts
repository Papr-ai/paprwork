/**
 * useArtifacts Hook - Artifact management operations
 */

import { useCallback, useEffect } from "react";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { gateway } from "../src/lib/gateway";

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

  // Apps use a fast stale-while-refresh path; other views load both kinds.
  const loadArtifacts = useCallback(async () => {
    const cached = useArtifactsStore.getState().artifacts;
    const hasCachedApps = cached.some((item) => item.type === "app");
    const blockForLoad = scope === "all" || !hasCachedApps;
    if (blockForLoad) setLoading(true);
    setError(null);

    try {
      if (scope === "apps") {
        const response = await gateway.send("app:list");
        const apps = (response.data as Artifact[]) || [];
        const current = useArtifactsStore.getState().artifacts;
        setArtifacts([
          ...current.filter((item) => item.type !== "app"),
          ...apps,
        ]);
      } else {
        const [docsResult, appsResult] = await Promise.allSettled([
          gateway.send("document:list"),
          gateway.send("app:list"),
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
        }

        setArtifacts([...documents, ...apps]);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load artifacts";
      if (blockForLoad) setError(message);
      console.error("[useArtifacts] Load error:", err);
    } finally {
      if (blockForLoad) setLoading(false);
    }
  }, [scope, setArtifacts, setLoading, setError]);

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

        const response = await gateway.send(messageType, {
          [payloadKey]: id,
          ...(type === "app" && options?.unpublishFromCloud
            ? { unpublishFromCloud: true }
            : {}),
        });
        const data = response.data as {
          deleted?: boolean;
          requiresUnpublishConfirm?: boolean;
        };
        if (data?.requiresUnpublishConfirm) {
          throw new Error("Published app requires unpublish confirmation");
        }
        if (data?.deleted === false) {
          throw new Error(`Failed to delete ${type}`);
        }
        removeArtifact(id);
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
