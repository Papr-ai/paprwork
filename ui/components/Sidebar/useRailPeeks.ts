/**
 * useRailPeeks — builds the Chats / Apps / Docs peek groups from real data:
 * favorites become "Pinned", recency becomes "Recent". Nothing new is stored.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChat } from "../../hooks/useChat";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { isUserFacingChatId } from "../../utils/chatVisibility";
import { useChatActivity, useDoneChatIds } from "../Chat/chatActivity";
import type { Artifact } from "../../stores/artifactsStore";
import type { SidebarFavorite } from "./useSidebarFavorites";
import { relativeTime, type PeekGroup, type PeekRow } from "./RailPeek";

const RECENT_CHATS = 6;
const RECENT_ARTIFACTS = 5;

const time = (iso?: string): number => (iso ? new Date(iso).getTime() || 0 : 0);

interface Args {
  favorites: SidebarFavorite[];
  openFavorite: (fav: SidebarFavorite) => void;
  removeFavorite: (id: string) => void;
}

export function useRailPeeks({ favorites, openFavorite, removeFavorite }: Args) {
  const { chats, loadMessages, loadChats } = useChat();
  const activityOf = useChatActivity();
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
        activity: activityOf(f.id.replace(/^chat-/, "")),
        onOpen: () => openFavorite(f),
        onRemove: () => removeFavorite(f.id),
      })),
    [favorites, activityOf, openFavorite, removeFavorite],
  );

  const openArtifact = useCallback(
    (a: Artifact & { type: "app" | "document" }) =>
      switchToTab(createTab(a.type, a.id, a.title, a.icon ? { icon: a.icon } : {})),
    [createTab, switchToTab],
  );

  const chatGroups = useMemo<PeekGroup[]>(() => {
    // Favorited chats are stored by tab id ("chat-<id>"); compare on the bare chat id so a
    // pinned chat doesn't also show up under Recent.
    const pinnedIds = new Set(favorites.map((f) => f.id.replace(/^chat-/, "")));
    const recent = chats
      .filter((c) => isUserFacingChatId(c.id) && !pinnedIds.has(c.id))
      .sort((a, b) => time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt))
      .slice(0, RECENT_CHATS)
      .map<PeekRow>((c) => ({
        id: c.id,
        title: c.title || "New Chat",
        sub: relativeTime(c.updatedAt || c.createdAt),
        activity: activityOf(c.id),
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
  }, [chats, activityOf, favorites, pinnedRows, loadMessages, createTab, switchToTab]);

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
  // Same signal as the tab bar's green dot — chat.hasUnread is never set, tab.hasUnread is.
  const doneIds = useDoneChatIds();
  const hasUnreadChats = doneIds.size > 0;

  // Re-read the chat list when the Chats peek opens (throttled) so chats touched elsewhere —
  // other windows, jobs, sync — are there too, not only ones this window saw change.
  const lastRefresh = useRef(0);
  const refreshChats = useCallback(() => {
    const now = Date.now();
    if (now - lastRefresh.current < 15_000) return;
    lastRefresh.current = now;
    void loadChats(true);
  }, [loadChats]);

  return { chatGroups, appGroups, docGroups, hasUnreadChats, refreshChats };
}
