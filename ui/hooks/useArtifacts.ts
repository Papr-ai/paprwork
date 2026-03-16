/**
 * useArtifacts Hook - Artifact management operations
 */

import { useCallback, useEffect } from "react";
import { useArtifactsStore, type Artifact } from "../stores/artifactsStore";
import { gateway } from "../src/lib/gateway";

export function useArtifacts() {
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

  // Load all artifacts (documents + apps)
  const loadArtifacts = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [docsResponse, appsResponse] = await Promise.all([
        gateway.send("document:list"),
        gateway.send("app:list"),
      ]);

      const documents = (docsResponse.data as Artifact[]) || [];
      const apps = (appsResponse.data as Artifact[]) || [];
      const combined = [...documents, ...apps];

      setArtifacts(combined);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load artifacts";
      setError(message);
      console.error("[useArtifacts] Load error:", err);
    } finally {
      setLoading(false);
    }
  }, [setArtifacts, setLoading, setError]);

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
    async (id: string, type: "document" | "app") => {
      setError(null);

      try {
        const messageType =
          type === "document" ? "document:delete" : "app:delete";
        const payloadKey = type === "document" ? "documentId" : "appId";

        await gateway.send(messageType, { [payloadKey]: id });
        removeArtifact(id);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Failed to delete ${type}`;
        setError(message);
        console.error(`[useArtifacts] Delete ${type} error:`, err);
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

  // Listen for favorite removal from sidebar
  useEffect(() => {
    const handleFavoriteRemovedFromSidebar = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { id, type } = customEvent.detail;
      
      // Find the artifact and toggle it off
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact && artifact.favorite) {
        console.log(`[useArtifacts] Unfavoriting from sidebar event: ${id}`);
        toggleFavorite(id, type || artifact.type as "document" | "app");
      }
    };

    const handleFavoriteDragAdd = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { id, type } = customEvent.detail;
      
      // Find the artifact and toggle it on
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact && !artifact.favorite) {
        console.log(`[useArtifacts] Favoriting from drag event: ${id}`);
        toggleFavorite(id, type as "document" | "app");
      }
    };

    window.addEventListener("papr-favorite-removed-from-sidebar", handleFavoriteRemovedFromSidebar);
    window.addEventListener("papr-favorite-drag-add", handleFavoriteDragAdd);
    return () => {
      window.removeEventListener("papr-favorite-removed-from-sidebar", handleFavoriteRemovedFromSidebar);
      window.removeEventListener("papr-favorite-drag-add", handleFavoriteDragAdd);
    };
  }, [artifacts, toggleFavorite]);

  // Load artifacts on mount
  useEffect(() => {
    loadArtifacts();
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
