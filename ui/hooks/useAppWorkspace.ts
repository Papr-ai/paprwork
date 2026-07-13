/**
 * useAppWorkspace — file tree, read/write, DB preview, and live sync.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../src/lib/gateway";

export type AppWorkspaceMode = "preview" | "files";

export type WorkspaceFileKind = "file" | "database" | "sqlite-internal" | "log";

export type WorkspaceFileTarget =
  | {
      scope: "app";
      appId: string;
      path: string;
      kind: WorkspaceFileKind;
      readOnly: boolean;
    }
  | {
      scope: "job";
      jobId: string;
      path: string;
      kind: WorkspaceFileKind;
      readOnly: boolean;
    };

export interface WorkspaceFileEntry {
  path: string;
  kind: WorkspaceFileKind;
  readOnly: boolean;
}

export interface WorkspaceJobFiles {
  jobId: string;
  name: string;
  alias: string;
  files: WorkspaceFileEntry[];
}

export interface AppWorkspaceFilesResult {
  appId: string;
  appFiles: WorkspaceFileEntry[];
  jobs: WorkspaceJobFiles[];
}

export interface JobDbPreviewTable {
  name: string;
  columns: Array<{ name: string; type: string; pk: boolean }>;
  rowCount: number;
  rows: Record<string, unknown>[];
}

export interface JobDbPreviewResult {
  dbPath: string;
  tables: JobDbPreviewTable[];
  selectedTable: string | null;
}

function fileKey(target: WorkspaceFileTarget): string {
  if (target.scope === "app") {
    return `app:${target.path}`;
  }
  return `job:${target.jobId}:${target.path}`;
}

function isEditable(target: WorkspaceFileTarget): boolean {
  if (target.kind === "database" || target.kind === "sqlite-internal") {
    return false;
  }
  if (target.kind === "log") {
    return false;
  }
  return !target.readOnly;
}

export function useAppWorkspace(appId: string) {
  const [workspace, setWorkspace] = useState<AppWorkspaceFilesResult | null>(
    null,
  );
  const [loadingTree, setLoadingTree] = useState(false);
  const [selected, setSelected] = useState<WorkspaceFileTarget | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [dbPreview, setDbPreview] = useState<JobDbPreviewResult | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadingDb, setLoadingDb] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const savedContentRef = useRef(savedContent);
  const contentRef = useRef(content);

  selectedRef.current = selected;
  savedContentRef.current = savedContent;
  contentRef.current = content;

  const isDirty = content !== savedContent;
  const viewMode = selected?.kind === "database" ? "database" : "code";

  const refreshTree = useCallback(async () => {
    setLoadingTree(true);
    setError(null);
    try {
      const resp = await gateway.send("app:list-files", { appId });
      setWorkspace(resp.data as AppWorkspaceFilesResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingTree(false);
    }
  }, [appId]);

  const loadDbPreview = useCallback(
    async (target: WorkspaceFileTarget, tableName?: string) => {
      if (target.scope !== "job" || target.kind !== "database") return;

      setLoadingDb(true);
      setError(null);
      setExternalChange(null);
      setSelected(target);
      setContent("");
      setSavedContent("");

      try {
        const resp = await gateway.send("jobs:db-preview", {
          jobId: target.jobId,
          filename: target.path,
          tableName,
        });
        setDbPreview(resp.data as JobDbPreviewResult);
      } catch (err) {
        setDbPreview(null);
        setError((err as Error).message);
      } finally {
        setLoadingDb(false);
      }
    },
    [],
  );

  const openTarget = useCallback(
    async (target: WorkspaceFileTarget) => {
      if (target.kind === "database") {
        await loadDbPreview(target);
        return;
      }

      if (target.kind === "sqlite-internal") {
        setSelected(target);
        setDbPreview(null);
        setContent("");
        setSavedContent("");
        setExternalChange(null);
        setError(null);
        return;
      }

      if (!isEditable(target) && target.kind !== "log") {
        setSelected(target);
        setDbPreview(null);
        setContent("");
        setSavedContent("");
        setExternalChange(null);
        setError("This file is read-only.");
        return;
      }

      setLoadingFile(true);
      setError(null);
      setExternalChange(null);
      setDbPreview(null);

      try {
        let fileContent = "";
        if (target.scope === "app") {
          const resp = await gateway.send("app:read-file", {
            appId: target.appId,
            filename: target.path,
          });
          const data = resp.data as { content?: string };
          fileContent = data.content ?? "";
        } else {
          const resp = await gateway.send("jobs:read-file", {
            jobId: target.jobId,
            filename: target.path,
          });
          const data = resp.data as { content?: string };
          fileContent = data.content ?? "";
        }
        setSelected(target);
        setContent(fileContent);
        setSavedContent(fileContent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingFile(false);
      }
    },
    [loadDbPreview],
  );

  const saveFile = useCallback(async () => {
    const target = selectedRef.current;
    if (!target || !isEditable(target)) return false;

    setSaving(true);
    setError(null);
    try {
      if (target.scope === "app") {
        await gateway.send("app:write-file", {
          appId: target.appId,
          filename: target.path,
          content,
        });
      } else {
        await gateway.send("jobs:write-file", {
          jobId: target.jobId,
          filename: target.path,
          content,
        });
      }
      setSavedContent(content);
      setExternalChange(null);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [content]);

  const reloadFromDisk = useCallback(async () => {
    const target = selectedRef.current;
    if (!target) return;
    setExternalChange(null);
    await openTarget(target);
  }, [openTarget]);

  const selectDbTable = useCallback(
    async (tableName: string) => {
      const target = selectedRef.current;
      if (!target || target.kind !== "database") return;
      await loadDbPreview(target, tableName);
    },
    [loadDbPreview],
  );

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const data = customEvent.detail;
      if (data.type !== "app:file-changed") return;
      if (data.data?.appId !== appId) return;

      void refreshTree();

      const current = selectedRef.current;
      const changedPath = data.data?.filename as string | undefined;
      if (
        !current ||
        current.scope !== "app" ||
        !changedPath ||
        current.path !== changedPath
      ) {
        return;
      }

      if (savedContentRef.current === contentRef.current) {
        void openTarget(current);
        return;
      }

      setExternalChange(changedPath);
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [appId, openTarget, refreshTree]);

  return {
    workspace,
    loadingTree,
    selected,
    selectedKey: selected ? fileKey(selected) : null,
    viewMode,
    content,
    setContent,
    dbPreview,
    isDirty,
    loadingFile,
    loadingDb,
    saving,
    error,
    externalChange,
    refreshTree,
    openTarget,
    saveFile,
    reloadFromDisk,
    selectDbTable,
  };
}

export function detectWorkspaceLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    svg: "xml",
  };
  return map[ext] ?? "text";
}
