/**
 * DuplicateAppNameModal — pick the name before "Duplicate as my own app"
 * creates the copy. Prefilled with "{title} (my copy)". The server still makes
 * it unique (e.g. "Name_1") if another app already has that name.
 */

import { useEffect, useRef, useState } from "react";
import "./MoveAppModal.css";

interface DuplicateAppNameModalProps {
  open: boolean;
  sourceTitle: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}

export function DuplicateAppNameModal({
  open,
  sourceTitle,
  busy,
  onCancel,
  onConfirm,
}: DuplicateAppNameModalProps) {
  const [name, setName] = useState(`${sourceTitle} (my copy)`);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(`${sourceTitle} (my copy)`);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [open, sourceTitle]);

  if (!open) return null;
  const trimmed = name.trim();

  return (
    <div className="move-app-modal__backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="move-app-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-app-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="duplicate-app-modal-title" className="move-app-modal__title">
          Duplicate as my own app
        </h3>
        <p className="move-app-modal__subtitle">
          Your own copy of <strong>{sourceTitle}</strong>: fresh data, its own
          jobs, no link to the publisher. You can edit, publish and share it.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && !busy) onConfirm(trimmed);
          }}
        >
          <label className="move-app-modal__label">
            Name
            <input
              ref={inputRef}
              className="move-app-modal__select"
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) onCancel();
              }}
            />
          </label>
          <div className="move-app-modal__actions">
            <button type="button" className="move-app-modal__btn move-app-modal__btn--secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="move-app-modal__btn move-app-modal__btn--primary" disabled={!trimmed || busy}>
              {busy ? "Duplicating…" : "Duplicate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
