/**
 * useSidebarFavorites — favorites logic lifted unchanged from the old FavoritesList so the rail
 * can show them inside the Chats / Apps / Docs peeks and accept drag-to-favorite anywhere on the rail.
 *
 * Two sources (same hybrid approach as before):
 *  1. Artifacts (document/app) — artifacts store is the source of truth.
 *  2. Non-artifacts (chat/jobs/settings) — tabs with the isFavorite flag.
 */
import { useCallback, useMemo, useState } from "react";
import type React from "react";
import { useTabs } from "../../hooks/useTabs";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useTabStore } from "../../stores/tabStore";
import { gateway } from "../../src/lib/gateway";

export interface SidebarFavorite {
  id: string;
  type: "chat" | "document" | "app";
  title: string;
  icon?: string;
}

const ARTIFACT_TAB_TYPES = ["document", "app", "artifacts", "documents", "apps"];

function toggleArtifactFavorite(id: string, type: string): void {
  const messageType = type === "document" ? "document:toggle-favorite" : "app:toggle-favorite";
  const payloadKey = type === "document" ? "documentId" : "appId";
  gateway
    .send(messageType, { [payloadKey]: id })
    .then((response) => {
      const updated = response.data as { favorite?: boolean };
      useArtifactsStore.getState().updateArtifact(id, { favorite: updated.favorite });
    })
    .catch((error: Error) => {
      console.error("[Sidebar] Failed to toggle artifact favorite:", error);
    });
}

function setTabFavorite(tabId: string, isFavorite: boolean): void {
  const { tabs } = useTabStore.getState();
  useTabStore.setState({ tabs: tabs.map((t) => (t.id === tabId ? { ...t, isFavorite } : t)) });
  gateway.send("app:toggle_favorite_tab", { tabId }).catch((error: Error) => {
    console.error("[Sidebar] Failed to toggle tab favorite:", error);
  });
}

export function useSidebarFavorites() {
  const { createTab, switchToTab } = useTabs();
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const tabs = useTabStore((s) => s.tabs);
  const [isDragOver, setIsDragOver] = useState(false);

  const favorites = useMemo<SidebarFavorite[]>(() => {
    const fromArtifacts = artifacts
      .filter((a) => a.favorite)
      .map((a) => ({ id: a.id, type: a.type as "document" | "app", title: a.title, icon: a.icon }));
    const fromTabs = tabs
      .filter((t) => t.isFavorite && !ARTIFACT_TAB_TYPES.includes(t.type))
      .map((t) => ({ id: t.id, type: t.type as SidebarFavorite["type"], title: t.title, icon: t.icon }));
    return [...fromArtifacts, ...fromTabs];
  }, [artifacts, tabs]);

  const removeFavorite = useCallback(
    (id: string) => {
      const artifact = artifacts.find((a) => a.id === id);
      if (artifact) toggleArtifactFavorite(id, artifact.type);
      else setTabFavorite(id, false);
    },
    [artifacts],
  );

  const openFavorite = useCallback(
    (fav: SidebarFavorite) => {
      if (artifacts.some((a) => a.id === fav.id)) {
        switchToTab(createTab(fav.type, fav.id, fav.title, fav.icon ? { icon: fav.icon } : {}));
      } else if (tabs.some((t) => t.id === fav.id)) {
        switchToTab(fav.id);
      } else {
        console.error(`[Sidebar] Cannot open favorite ${fav.id} - not found`);
      }
    },
    [artifacts, tabs, createTab, switchToTab],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const raw = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
      if (!raw) return;
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const entityId = (data.id ?? data.tabId) as string | undefined;
        const entityType = data.type as string | undefined;
        if (!entityId || !entityType || !data.title) return;
        if (!["chat", "document", "app"].includes(entityType)) return;

        const artifact = artifacts.find((a) => a.id === entityId);
        if (artifact) {
          if (!artifact.favorite) toggleArtifactFavorite(entityId, entityType);
          return;
        }
        const existing = useTabStore.getState().tabs.find((t) => t.id === entityId);
        if (!existing?.isFavorite) setTabFavorite(entityId, true);
      } catch {
        /* invalid drop data */
      }
    },
    [artifacts],
  );

  return {
    favorites,
    openFavorite,
    removeFavorite,
    isDragOver,
    dropHandlers: { onDragOver, onDragLeave, onDrop },
  };
}
