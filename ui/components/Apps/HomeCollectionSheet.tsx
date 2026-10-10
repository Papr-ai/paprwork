/**
 * An open collection (iOS folder sheet): rename in place, reorder by dragging,
 * drag an app onto the dimmed background to take it out, or ungroup.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import { AppGlyph, AppName, type TileDnd } from "./HomeTiles";

interface Props {
  name: string;
  /** Automatic collections fill themselves: no rename, reorder or ungroup. */
  readOnly?: boolean;
  apps: Artifact[];
  autoFocusName: boolean;
  dnd: TileDnd;
  attention: (a: Artifact) => boolean;
  renamingId: string | null;
  onRenameFolder: (name: string) => void;
  onUngroup: () => void;
  onDropOut: () => void;
  onClose: () => void;
  onOpenApp: (a: Artifact) => void;
  onRenameApp: (a: Artifact, title: string) => void;
  onRenameDone: () => void;
  menuFor: (a: Artifact) => ReactNode;
}

export function HomeCollectionSheet(p: Props) {
  const [name, setName] = useState(p.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => {
    if (p.autoFocusName) requestAnimationFrame(() => input.current?.select());
  }, [p.autoFocusName]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.activeElement !== input.current) p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const commitName = () => {
    if (name.trim() && name.trim() !== p.name) p.onRenameFolder(name);
    else setName(p.name);
  };

  return (
    <>
      <div
        className="ah-sheet__back"
        onClick={p.onClose}
        onDragOver={(e) => p.dnd.dragging && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          p.onDropOut();
        }}
      />
      <div className="ah-sheet" role="dialog" aria-label={p.name}>
        {p.readOnly ? (
          <h2 className="ah-sheet__name">{p.name}</h2>
        ) : (
        <input
          ref={input}
          className="ah-sheet__name"
          value={name}
          aria-label="Collection name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") input.current?.blur();
            if (e.key === "Escape") {
              setName(p.name);
              requestAnimationFrame(() => input.current?.blur());
            }
          }}
        />
        )}
        <div className="ah-sheet__grid">
          {p.apps.map((a) => (
            <div
              key={a.id}
              className={`ah-cell ${p.dnd.dragging === a.id ? "is-dragging" : ""} ${
                p.dnd.hover?.id === a.id ? `ah-drop-${p.dnd.hover.zone}` : ""
              }`}
              draggable={!p.readOnly}
              onDragStart={(e) => p.dnd.onDragStart(a.id, e, a)}
              onDragOver={(e) => p.dnd.onDragOver(a.id, e, false)}
              onDrop={(e) => p.dnd.onDrop(a.id, e)}
              onDragEnd={p.dnd.onDragEnd}
            >
              <button type="button" className="ah-cell__open" onClick={() => p.onOpenApp(a)}>
                <span className="ah-cell__ic">
                  <AppGlyph app={a} size={60} />
                  {p.attention(a) ? <span className="ah-bad">!</span> : null}
                </span>
                <AppName
                  app={a}
                  className="ah-cell__t"
                  renaming={p.renamingId === a.id}
                  onRename={(t) => p.onRenameApp(a, t)}
                  onDone={p.onRenameDone}
                />
              </button>
              <span className="ah-cell__menu">{p.menuFor(a)}</span>
            </div>
          ))}
        </div>
        {p.readOnly ? (
          <p className="ah-sheet__hint">Fills itself. Nothing here moves your apps.</p>
        ) : (
          <div className="ah-sheet__foot">
            <p className="ah-sheet__hint">Drag an app outside this box to take it out of the collection.</p>
            <button type="button" onClick={p.onUngroup}>
              Ungroup
            </button>
          </div>
        )}
      </div>
    </>
  );
}
