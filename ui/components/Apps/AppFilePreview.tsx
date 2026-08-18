/** Right-pane preview and download surface for a stored App File. */

import React, { useEffect, useState } from "react";
import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema";
import { appFileContentUrl, downloadAppFile, resolveAppFileUrl } from "../../utils/appFilesApi";
import { formatBytes } from "../../utils/appFilesFormat";
import { previewKind } from "../../utils/appFilesPreview";
import "./AppFilePreview.css";

export function AppFilePreview({ appId, file }: { appId: string; file: AppFileRow }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const kind = previewKind(file);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setText(null);
    setError(null);
    void resolveAppFileUrl(appId, file.id)
      .then(async (resolved) => {
        if (cancelled) return;
        const readable = resolved.location.kind === "local" ? appFileContentUrl(appId, file.id) : resolved.url;
        if (!readable) throw new Error(resolved.location.reason ?? "No readable copy is available.");
        setUrl(readable);
        if (kind === "text") {
          const response = await fetch(readable);
          if (!response.ok) throw new Error(`Preview failed (${response.status})`);
          const body = await response.text();
          if (!cancelled) setText(body.slice(0, 512_000));
        }
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => { cancelled = true; };
  }, [appId, file.id, kind]);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try { await downloadAppFile(appId, file); }
    catch (err) { setError((err as Error).message); }
    finally { setDownloading(false); }
  };

  return (
    <div className="app-file-preview">
      <header className="app-file-preview__head">
        <div className="app-file-preview__title-wrap">
          <strong className="app-file-preview__title">{file.file_name}</strong>
          <span className="app-file-preview__meta">{file.mime || "Unknown type"} · {formatBytes(file.size_bytes)}</span>
        </div>
        <button className="app-file-preview__download" type="button" disabled={downloading || !url} onClick={() => void download()}>
          {downloading ? "Downloading…" : "Download"}
        </button>
      </header>

      {error ? <div className="app-file-preview__error">{error}</div> : null}
      {!url && !error ? <div className="app-file-preview__status">Preparing preview…</div> : null}
      {url && kind === "audio" ? <audio className="app-file-preview__audio" controls preload="metadata" src={url} /> : null}
      {url && kind === "video" ? <video className="app-file-preview__video" controls preload="metadata" src={url} /> : null}
      {url && kind === "image" ? <div className="app-file-preview__image-wrap"><img className="app-file-preview__image" src={url} alt={file.file_name} /></div> : null}
      {url && kind === "pdf" ? <iframe className="app-file-preview__pdf" src={url} title={file.file_name} /> : null}
      {url && kind === "text" ? <pre className="app-file-preview__text">{text ?? "Loading text…"}</pre> : null}
      {url && kind === "unsupported" ? (
        <div className="app-file-preview__unsupported">
          <div className="app-file-preview__file-glyph" aria-hidden>↓</div>
          <strong>No inline preview for this file type</strong>
          <span>Download the original file to open it in another app.</span>
        </div>
      ) : null}
    </div>
  );
}
