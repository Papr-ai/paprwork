/**
 * Artifacts Store - Manages documents and apps state
 */

import { create } from "zustand";

export type ArtifactType = "document" | "app" | "file";

/** Short label for chat context / UI chips (not the same as storage kind). */
export function artifactTypeLabel(type: ArtifactType): string {
  switch (type) {
    case "document":
      return "Document";
    case "app":
      return "App";
    case "file":
      return "File";
  }
}

export interface ArtifactCloudLineage {
  mode: "fork" | "track";
  sourceAppId: string;
  sourceSlug: string;
  sourceNamespaceId: string;
  installedAt: string;
  lastSyncedAt?: string;
}

export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  content?: string;
  preview?: string;
  icon?: string;
  favorite?: boolean;
  /** Lifecycle status (apps only). Undefined = "active". */
  status?: "draft" | "active" | "archived";
  /** ISO timestamp of the last time the user opened this app. */
  lastOpenedAt?: string;
  /** Total number of times the user has opened this app. */
  openCount?: number;
  tags?: string[];
  wordCount?: number;
  description?: string;
  cloudLineage?: ArtifactCloudLineage;
  metadata?: {
    filePath?: string;
    fileSize?: number;
    fileType?: string;
    [key: string]: unknown;
  };
}

interface ArtifactsState {
  artifacts: Artifact[];
  loading: boolean;
  error: string | null;
  filter: ArtifactType | "all";
  searchQuery: string;

  // Actions
  setArtifacts: (artifacts: Artifact[]) => void;
  addArtifact: (artifact: Artifact) => void;
  updateArtifact: (id: string, updates: Partial<Artifact>) => void;
  removeArtifact: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setFilter: (filter: ArtifactType | "all") => void;
  setSearchQuery: (query: string) => void;
  toggleFavorite: (id: string) => void;

  // Computed
  getFilteredArtifacts: () => Artifact[];
}

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  artifacts: [],
  loading: false,
  error: null,
  filter: "all",
  searchQuery: "",

  setArtifacts: (artifacts) => set({ artifacts }),

  addArtifact: (artifact) =>
    set((state) => ({
      artifacts: [artifact, ...state.artifacts],
    })),

  updateArtifact: (id, updates) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === id ? { ...a, ...updates } : a,
      ),
    })),

  removeArtifact: (id) =>
    set((state) => ({
      artifacts: state.artifacts.filter((a) => a.id !== id),
    })),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  setFilter: (filter) => set({ filter }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  toggleFavorite: (id) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === id ? { ...a, favorite: !a.favorite } : a,
      ),
    })),

  getFilteredArtifacts: () => {
    const { artifacts, filter, searchQuery } = get();

    let filtered = artifacts;

    // Apply type filter
    if (filter !== "all") {
      filtered = filtered.filter((a) => a.type === filter);
    }

    // Apply search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (a) =>
          a.title.toLowerCase().includes(query) ||
          a.id.toLowerCase().includes(query) ||
          a.description?.toLowerCase().includes(query) ||
          a.tags?.some((tag) => tag.toLowerCase().includes(query)) ||
          a.cloudLineage?.sourceSlug.toLowerCase().includes(query) ||
          Object.values(a.metadata ?? {}).some(
            (value) =>
              typeof value === "string" && value.toLowerCase().includes(query),
          ),
      );
    }

    return filtered;
  },
}));
