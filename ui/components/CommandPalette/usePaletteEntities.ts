/**
 * Continue / Pinned / Results for ⌘K, built from the same stores the rail peeks read
 * (chat list, artifacts, favorites). Nothing new is stored or fetched.
 */
import { useCallback, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useTabStore } from "../../stores/tabStore";
import { isUserFacingChatId } from "../../utils/chatVisibility";
import { useWorkingChatIds } from "../Agent/agentWork";

export type EntityKind = "chat" | "app" | "document";

export interface PaletteEntity {
  /** `${kind}-${id}`: the same thing reached two ways (pinned + recent) dedupes on this. */
  key: string;
  id: string;
  kind: EntityKind;
  title: string;
  /** Last touched, ms. */
  at: number;
  /** Pen is working in this chat right now. */
  live: boolean;
  icon?: string;
  /** Pinned chats are favorited tabs; reopen that tab rather than making a new one. */
  tabId?: string;
}

const KIND_ORDER: EntityKind[] = ["chat", "app", "document"];
const MAX_RESULTS = 8;
const time = (iso?: string): number => (iso ? new Date(iso).getTime() || 0 : 0);

export function usePaletteEntities() {
  const chats = useChatStore((s) => s.chats);
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const tabs = useTabStore((s) => s.tabs);
  const working = useWorkingChatIds();

  /** Everything openable, newest first. */
  const recent = useMemo<PaletteEntity[]>(() => {
    const fromChats = chats
      .filter((c) => isUserFacingChatId(c.id))
      .map<PaletteEntity>((c) => ({
        key: `chat-${c.id}`, id: c.id, kind: "chat", title: c.title || "New Chat",
        at: time(c.updatedAt), live: working.has(c.id),
      }));
    const fromArtifacts = artifacts
      .filter((a) => (a.type === "app" || a.type === "document") && a.status !== "archived" && !a.archived)
      .map<PaletteEntity>((a) => ({
        key: `${a.type}-${a.id}`, id: a.id, kind: a.type as EntityKind,
        title: a.title || (a.type === "app" ? "Untitled App" : "Untitled"),
        at: time(a.lastOpenedAt ?? a.updatedAt), live: false, icon: a.icon,
      }));
    return [...fromChats, ...fromArtifacts].sort((a, b) => b.at - a.at);
  }, [chats, artifacts, working]);

  /** The latest chat, app, and doc (one of each), so picking up where you left off is one keystroke. */
  const continueItems = useMemo(
    () => KIND_ORDER.map((kind) => recent.find((e) => e.kind === kind)).filter((e): e is PaletteEntity => !!e),
    [recent],
  );

  /** Same favorites as the rail: artifacts flagged favorite, then favorited chat tabs. */
  const pinned = useMemo<PaletteEntity[]>(() => {
    const favIds = new Set(artifacts.filter((a) => a.favorite).map((a) => a.id));
    const fromArtifacts = recent.filter((e) => e.kind !== "chat" && favIds.has(e.id));
    const fromTabs = tabs
      .filter((t) => t.isFavorite && t.type === "chat")
      .map<PaletteEntity>((t) => ({
        key: `chat-${t.entityId}`, id: t.entityId, kind: "chat", title: t.title,
        at: 0, live: working.has(t.entityId), tabId: t.id,
      }));
    return [...fromArtifacts, ...fromTabs];
  }, [artifacts, recent, tabs, working]);

  const search = useCallback(
    (term: string): PaletteEntity[] => {
      const q = term.trim().toLowerCase();
      if (!q) return [];
      return recent.filter((e) => e.title.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
    },
    [recent],
  );

  return { continueItems, pinned, search };
}
