/**
 * useDocuments Hook - Document fetch / save / version history via gateway
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { gateway } from "../src/lib/gateway";

export interface DocumentData {
  id: string;
  title: string;
  content: string;
  filePath: string;
  tags: string[];
  favorite: boolean;
  preview: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  versionId: string;
  timestamp: string;
  reason: string;
  preview: string;
}

export interface DocumentVersionFull extends DocumentVersion {
  content: string;
}

export function useDocument(documentId: string | null) {
  const [document, setDocument] = useState<DocumentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  // Fetch the document
  const loadDocument = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);

    try {
      const response = await gateway.send("document:get", { documentId });
      setDocument(response.data as DocumentData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load document");
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  // Save content (debounced externally by the editor)
  const saveContent = useCallback(
    async (content: string) => {
      if (!documentId) return;
      setSaving(true);
      savingRef.current = true;

      try {
        // Save a version first
        await gateway.send("document:save-version", {
          documentId,
          content,
          reason: "auto-save",
        });

        // Then update the document
        const response = await gateway.send("document:update", {
          documentId,
          content,
        });
        setDocument(response.data as DocumentData);
      } catch (err) {
        console.error("[useDocument] Save error:", err);
      } finally {
        setSaving(false);
        // Delay clearing the flag so the file-watcher event
        // triggered by our own write gets ignored
        setTimeout(() => {
          savingRef.current = false;
        }, 500);
      }
    },
    [documentId],
  );

  // Debounced save (1s after last keystroke)
  const debouncedSave = useCallback(
    (content: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = setTimeout(() => {
        saveContent(content);
      }, 1000);
    },
    [saveContent],
  );

  // Update title
  const updateTitle = useCallback(
    async (title: string) => {
      if (!documentId) return;
      try {
        const response = await gateway.send("document:update", {
          documentId,
          title,
        });
        setDocument(response.data as DocumentData);
      } catch (err) {
        console.error("[useDocument] Title update error:", err);
      }
    },
    [documentId],
  );

  // Load version history
  const loadVersions = useCallback(async () => {
    if (!documentId) return;
    try {
      const response = await gateway.send("document:versions", { documentId });
      setVersions((response.data as DocumentVersion[]) || []);
    } catch (err) {
      console.error("[useDocument] Versions load error:", err);
    }
  }, [documentId]);

  // Get full version
  const getVersion = useCallback(
    async (versionId: string): Promise<DocumentVersionFull | null> => {
      if (!documentId) return null;
      try {
        const response = await gateway.send("document:get-version", {
          documentId,
          versionId,
        });
        return response.data as DocumentVersionFull;
      } catch (err) {
        console.error("[useDocument] Get version error:", err);
        return null;
      }
    },
    [documentId],
  );

  // Restore version
  const restoreVersion = useCallback(
    async (versionId: string) => {
      if (!documentId) return;
      try {
        const response = await gateway.send("document:restore-version", {
          documentId,
          versionId,
        });
        setDocument(response.data as DocumentData);
      } catch (err) {
        console.error("[useDocument] Restore version error:", err);
      }
    },
    [documentId],
  );

  // Watch for external file changes (e.g. agent editing via bash)
  useEffect(() => {
    if (!documentId) return;

    gateway.send("document:watch", { documentId }).catch(() => {
      /* watching is best-effort */
    });

    // The gateway client dispatches broadcast messages (no id) as
    // CustomEvent("gateway-broadcast") on window. Listen for document changes.
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        type?: string;
        data?: { documentId?: string };
      } | undefined;
      if (
        detail?.type === "document:content-changed" &&
        detail.data?.documentId === documentId
      ) {
        // Skip if the user is currently saving (avoids save → watch → reload loop)
        if (savingRef.current) return;

        // Debounce: fs.watch can fire multiple times per write
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => {
          loadDocument();
        }, 300);
      }
    };

    window.addEventListener("gateway-broadcast", handler);

    return () => {
      window.removeEventListener("gateway-broadcast", handler);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      gateway.send("document:unwatch", { documentId }).catch(() => {});
    };
  }, [documentId, loadDocument]);

  // Initial load
  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  // Cleanup save timer
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  return {
    document,
    loading,
    error,
    saving,
    versions,
    loadDocument,
    saveContent,
    debouncedSave,
    updateTitle,
    loadVersions,
    getVersion,
    restoreVersion,
  };
}
