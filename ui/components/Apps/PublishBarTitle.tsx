/**
 * PublishBarTitle — app name in the share bar; click to rename.
 *
 * Saves through app:update, which updates apps.json, metadata.json and the
 * index.html <title> (when it matched the old name), then broadcasts
 * app:list-updated so tabs and the Apps page pick up the new name.
 * The published slug is deliberately left alone: renaming must not break
 * links people already have.
 */

import { useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";

interface PublishBarTitleProps {
  appId: string;
  title: string;
  /** Called with the saved name (may differ if made unique, e.g. "Name_1"). */
  onRenamed?: (title: string) => void;
}

export function PublishBarTitle({ appId, title, onRenamed }: PublishBarTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === title) {
      setEditing(false);
      setDraft(title);
      return;
    }
    setSaving(true);
    try {
      const resp = await gateway.send("app:update", { appId, title: next });
      const saved = (resp.data as { title?: string } | undefined)?.title ?? next;
      onRenamed?.(saved);
    } catch {
      setDraft(title);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="mini-app-publish-bar__title mini-app-publish-bar__title-input"
        value={draft}
        disabled={saving}
        aria-label="App name"
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="mini-app-publish-bar__title mini-app-publish-bar__title-button"
      title="Rename app"
      onClick={() => setEditing(true)}
    >
      {title}
    </button>
  );
}
