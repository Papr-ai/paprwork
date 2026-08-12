/**
 * App Files panel — drop large files here instead of into git.
 *
 * Design rules this enforces, from the requirements:
 *   - Zero sharing prompts during upload. Dropping a file uploads it; privacy
 *     is a property you can change afterwards, not a question asked up front.
 *   - Nothing is ever deleted without an explicit tap.
 *   - Honest progress for multi-GB files, so a slow upload is legible as slow
 *     rather than stuck.
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
import { formatBytes, reclaimableBytes } from "../../utils/appFilesFormat";
import { AppFileRowItem } from "./AppFileRowItem";
import "./AppFilesPanel.css";

interface AppFilesPanelProps {
  appId: string;
}

export function AppFilesPanel({ appId }: AppFilesPanelProps) {
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

      // Electron exposes the real path, so the gateway streams from disk and
      // the renderer never holds the bytes — the only way a 10 GB drop works.
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => Boolean(path));

      if (paths.length === 0) {
        setError("Could not read the dropped file's location.");
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

  const withBusy = useCallback(
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

  const reclaimable = reclaimableBytes(files);

  return (
    <div className="app-files">
      <div
        className={`app-files__drop${dragging ? " app-files__drop--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <p className="app-files__drop-title">Drop files to store them</p>
        <p className="app-files__drop-hint">
          Video, audio and datasets of any size. They stay out of git.
        </p>
      </div>

      {error && <p className="app-files__error">{error}</p>}

      {loading ? (
        <p className="app-files__empty">Loading…</p>
      ) : files.length === 0 ? (
        <p className="app-files__empty">No files yet.</p>
      ) : (
        <ul className="app-files__list">
          {files.map((file) => (
            <AppFileRowItem
              key={file.id}
              file={file}
              busy={busyId === file.id}
              onTogglePrivate={(isPrivate) =>
                void withBusy(file.id, () =>
                  setAppFilePrivacy(appId, file.id, isPrivate),
                )
              }
              onEvict={() =>
                void withBusy(file.id, () => evictAppFile(appId, file.object_key))
              }
              onRemove={() =>
                void withBusy(file.id, () => removeAppFile(appId, file.id))
              }
            />
          ))}
        </ul>
      )}

      {reclaimable > 0 && (
        <p className="app-files__reclaim">
          Free {formatBytes(reclaimable)} — files stay in the cloud. Use
          &ldquo;Free space&rdquo; on any file above.
        </p>
      )}
    </div>
  );
}
