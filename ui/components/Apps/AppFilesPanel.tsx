/**
 * App Files — store large files with an app instead of in git.
 *
 * One job: drop a file, it is stored. Everything else is secondary and stays
 * out of sight until needed.
 *
 * Two decisions worth naming:
 *
 *   - The drop zone only appears when the list is empty or a drag is in
 *     progress. A permanent dashed box would occupy the panel forever to teach
 *     something learned once; when files exist, the list itself is the target.
 *   - Row actions are revealed on hover, like Finder and Mail. Three controls
 *     on every row is visual noise proportional to file count; at rest the
 *     list reads as name and size, which is what someone scans for.
 */

import React, { useCallback, useEffect, useState } from "react";
import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema";
import {
  evictAppFile,
  listAppFiles,
  removeAppFile,
  setAppFilePrivacy,
  uploadAppFile,
} from "../../utils/appFilesApi";
import { formatBytes, totalBytes } from "../../utils/appFilesFormat";
import { AppFileRowItem } from "./AppFileRowItem";
import "./AppFilesPanel.css";

export function AppFilesPanel({ appId }: { appId: string }) {
  const [files, setFiles] = useState<AppFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await listAppFiles(appId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);

      // Electron gives the real path, so the gateway streams from disk and the
      // renderer never holds the bytes — the only way a 10 GB drop works.
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => Boolean(path));

      if (paths.length === 0) {
        setError("Could not read that file's location.");
        return;
      }
      for (const path of paths) {
        try {
          await uploadAppFile(appId, path);
        } catch (err) {
          setError((err as Error).message);
        }
      }
      await refresh();
    },
    [appId, refresh],
  );

  const act = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const stored = totalBytes(files);

  return (
    <section
      className={`app-files${dragging ? " app-files--dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <header className="app-files__head">
        <h3>Files</h3>
        {stored > 0 && <span className="app-files__total">{formatBytes(stored)}</span>}
      </header>

      {error && <p className="app-files__error">{error}</p>}

      {loading ? (
        // Never render an empty box. If the gateway is slow or down this
        // state can persist, and a panel with only a heading looks broken
        // rather than busy.
        <p className="app-files__empty">Loading…</p>
      ) : files.length === 0 ? (
        <p className="app-files__empty">Drop a file to store it outside git.</p>
      ) : (
        <ul className="app-files__list">
          {files.map((file) => (
            <AppFileRowItem
              key={file.id}
              file={file}
              busy={busyId === file.id}
              onTogglePrivate={(isPrivate) =>
                void act(file.id, () => setAppFilePrivacy(appId, file.id, isPrivate))
              }
              onEvict={() => void act(file.id, () => evictAppFile(appId, file.object_key))}
              onRemove={() => void act(file.id, () => removeAppFile(appId, file.id))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
