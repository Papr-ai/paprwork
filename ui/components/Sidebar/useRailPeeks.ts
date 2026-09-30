/**
 * useRailPeeks — builds the Chats / Apps / Docs peek groups from real data:
 * favorites become "Pinned", recency becomes "Recent". Nothing new is stored.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useChat } from "../../hooks/useChat";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { isUserFacingChatId } from "../../utils/chatVisibility";
import { useWorkingChatIds } from "../Agent/agentWork";
import type { Artifact } from "../../stores/artifactsStore";
import type { SidebarFavorite } from "./useSidebarFavorites";
import { relativeTime, type PeekGroup, type PeekRow } from "./RailPeek";
import { DEFAULT_HOME_APP_ID } from "../../constants/defaultHomeApp";
import { switchToFocusTab } from "../../lib/ensureDefaultChatTab";

const RECENT_CHATS = 6;
const RECENT_ARTIFACTS = 5;

const time = (iso?: string): number => (iso ? new Date(iso).getTime() || 0 : 0);

interface Args {
  favorites: SidebarFavorite[];
  openFavorite: (fav: SidebarFavorite) => void;
  removeFavorite: (id: string) => void;
}

export function useRailPeeks({ favorites, openFavorite, removeFavorite }: Args) {
  const { chats, loadMessages } = useChat();
  const workingIds = useWorkingChatIds();
  const { artifacts, loadArtifacts } = useArtifacts();
  const { createTab, switchToTab } = useTabs();

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const pinnedRows = useCallback(
    (match: (f: SidebarFavorite) => boolean): PeekRow[] =>
      favorites.filter(match).map((f) => ({
        id: `fav-${f.id}`,
        title: f.title,
        live: workingIds.has(f.id),
        onOpen: () => openFavorite(f),
        onRemove: () => removeFavorite(f.id),
      })),
    [favorites, workingIds, openFavorite, removeFavorite],
  );

  const openArtifact = useCallback(
    (a: Artifact & { type: "app" | "document" }) => {
      if (a.id === DEFAULT_HOME_APP_ID) return void switchToFocusTab();
      switchToTab(createTab(a.type, a.id, a.title, a.icon ? { icon: a.icon } : {}));
    },
    [createTab, switchToTab],
  );

  const chatGroups = useMemo<PeekGroup[]>(() => {
    const pinnedIds = new Set(favorites.map((f) => f.id));
    const recent = chats
      .filter((c) => isUserFacingChatId(c.id) && !pinnedIds.has(c.id))
      .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
      .slice(0, RECENT_CHATS)
      .map<PeekRow>((c) => ({
        id: c.id,
        title: c.title || "New Chat",
        sub: relativeTime(c.updatedAt),
        live: workingIds.has(c.id),
        onOpen: () => {
          void loadMessages(c.id);
          switchToTab(createTab("chat", c.id, c.title || "New Chat"));
        },
      }));
    // Anything favorited that isn't an app or doc (chats, jobs, settings) is pinned under Chats.
    const pinned = pinnedRows((f) => f.type !== "app" && f.type !== "document");
    return [
      { title: "Pinned", pinned: true, rows: pinned },
      { title: "Recent", rows: recent },
    ];
  }, [chats, workingIds, favorites, pinnedRows, loadMessages, createTab, switchToTab]);

  const artifactGroups = useCallback(
    (type: "app" | "document"): PeekGroup[] => {
      const recent = artifacts
        .filter(
          (a): a is Artifact & { type: "app" | "document" } =>
            a.type === type && !a.favorite && a.status !== "archived" && !a.archived,
        )
        .sort((a, b) => time(b.lastOpenedAt ?? b.updatedAt) - time(a.lastOpenedAt ?? a.updatedAt))
        .slice(0, RECENT_ARTIFACTS)
        .map<PeekRow>((a) => ({
          id: a.id,
          title: a.title,
          sub: relativeTime(a.lastOpenedAt ?? a.updatedAt),
          onOpen: () => openArtifact(a),
        }));
      return [
        { title: "Pinned", pinned: true, rows: pinnedRows((f) => f.type === type) },
        { title: "Recent", rows: recent },
      ];
    },
    [artifacts, pinnedRows, openArtifact],
  );

  const appGroups = useMemo(() => artifactGroups("app"), [artifactGroups]);
  const docGroups = useMemo(() => artifactGroups("document"), [artifactGroups]);
  const hasUnreadChats = useMemo(
    () => chats.some((c) => isUserFacingChatId(c.id) && c.hasUnread),
    [chats],
  );

  return { chatGroups, appGroups, docGroups, hasUnreadChats };
}
